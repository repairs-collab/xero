import { PostgresWebhookRepository } from '@bc5000/db/web';
import { DurableJobQueue } from '@bc5000/jobs';

import { getDatabaseClient } from './runtime.js';

let queuePromise: Promise<DurableJobQueue> | undefined;

const getQueue = (): Promise<DurableJobQueue> => {
  queuePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
    const queue = new DurableJobQueue({ databaseUrl });
    await queue.start();
    return queue;
  })();
  return queuePromise;
};

export async function getCommonWebhookDependencies() {
  const organisationId = process.env.WEBHOOK_ORGANISATION_ID;
  if (organisationId === undefined) {
    throw new Error('WEBHOOK_ORGANISATION_ID is required');
  }
  return {
    organisationId,
    repository: new PostgresWebhookRepository(getDatabaseClient().db),
    queue: await getQueue()
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
