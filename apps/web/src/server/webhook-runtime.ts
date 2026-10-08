import { eq } from 'drizzle-orm';

import {
  organisations,
  organisationVoiceSettings,
  PostgresWebhookRepository
} from '@bc5000/db/web';
import { getDatabaseClient } from './runtime.js';
import { getJobQueue } from './job-runtime.js';

export async function getCommonWebhookDependencies() {
  const database = getDatabaseClient().db;
  let organisationId = process.env.WEBHOOK_ORGANISATION_ID;
  if (organisationId === undefined) {
    const rows = await database
      .select({ id: organisations.id })
      .from(organisations)
      .limit(2);
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error(
        'WEBHOOK_ORGANISATION_ID is required when more than one organisation exists'
      );
    }
    organisationId = rows[0].id;
  }
  return {
    organisationId,
    repository: new PostgresWebhookRepository(database),
    queue: await getJobQueue()
  };
}

export const getSinchPublicKeys = (): ReadonlyMap<string, string> => {
  const encoded = process.env.SINCH_CALLBACK_PUBLIC_KEYS_JSON;
  if (encoded === undefined) {
    throw new Error('SINCH_CALLBACK_PUBLIC_KEYS_JSON is required');
  }
  const parsed = JSON.parse(encoded) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SINCH callback public keys must be a JSON object');
  }
  const entries = Object.entries(parsed).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  if (entries.length === 0) {
    throw new Error('At least one Sinch callback public key is required');
  }
  return new Map(entries);
};

export const getSinchWebhookToken = (): string => {
  const token = process.env.SINCH_WEBHOOK_TOKEN;
  if (token === undefined || token.length < 32) {
    throw new Error('SINCH_WEBHOOK_TOKEN must contain at least 32 characters');
  }
  return token;
};

export const getRetellWebhookApiKey = async (
  organisationId: string
): Promise<string> => {
  const database = getDatabaseClient().db;
  const [settings] = await database
    .select({ secretReference: organisationVoiceSettings.secretReference })
    .from(organisationVoiceSettings)
    .where(eq(organisationVoiceSettings.organisationId, organisationId))
    .limit(1);
  if (settings === undefined) {
    throw new Error('RETELL_WEBHOOK_NOT_CONFIGURED');
  }
  const environmentName = settings.secretReference.replace(/^env:/, '');
  if (!/^[A-Z][A-Z0-9_]*$/.test(environmentName)) {
    throw new Error('RETELL_WEBHOOK_SECRET_UNAVAILABLE');
  }
  const apiKey = process.env[environmentName]?.trim();
  if (!apiKey) throw new Error('RETELL_WEBHOOK_SECRET_UNAVAILABLE');
  return apiKey;
};
