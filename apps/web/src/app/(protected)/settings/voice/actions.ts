'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { organisationVoiceSettings } from '@bc5000/db/web';

import {
  getDatabaseClient,
  getVoiceProviderTester,
  requireWebSession,
  verifyVoicePreviewSession
} from '../../../../server/runtime.js';
import { createVoiceSettingsService } from './voice-settings.js';

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const optionalText = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
};

const integer = (formData: FormData, name: string): number => {
  const value = Number(requiredText(formData, name));
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
};

async function context() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const database = getDatabaseClient().db;
  return {
    database,
    session,
    settings: createVoiceSettingsService({
      database,
      session,
      tester: getVoiceProviderTester(),
      previewSessions: { verify: verifyVoicePreviewSession },
      clock: { now: () => new Date() }
    })
  };
}

export async function saveVoiceSettings(formData: FormData): Promise<void> {
  const { database, settings } = await context();
  const organisationId = requiredText(formData, 'organisationId');
  const submittedReference = optionalText(formData, 'secretReference');
  const [current] = await database
    .select({ secretReference: organisationVoiceSettings.secretReference })
    .from(organisationVoiceSettings)
    .where(eq(organisationVoiceSettings.organisationId, organisationId))
    .limit(1);
  const secretReference = submittedReference ?? current?.secretReference;
  if (secretReference === undefined) {
    throw new Error('secretReference is required');
  }
  await settings.save({
    organisationId,
    provider: 'RETELL',
    secretReference,
    previewPublicKey: requiredText(formData, 'previewPublicKey'),
    agentId: requiredText(formData, 'agentId'),
    agentVersion: integer(formData, 'agentVersion'),
    voiceId: requiredText(formData, 'voiceId'),
    voiceLabel: requiredText(formData, 'voiceLabel'),
    outboundNumber: requiredText(formData, 'outboundNumber'),
    transferSipUri: optionalText(formData, 'transferSipUri'),
    fallbackOfficeNumber: requiredText(formData, 'fallbackOfficeNumber'),
    officeDestinationLabel: requiredText(
      formData,
      'officeDestinationLabel'
    ),
    timezone: requiredText(formData, 'timezone'),
    weekdayStartLocal: requiredText(formData, 'weekdayStartLocal'),
    weekdayEndLocal: requiredText(formData, 'weekdayEndLocal')
  });
  revalidatePath('/settings/voice');
}

export async function testVoiceConnection(formData: FormData): Promise<void> {
  const { settings } = await context();
  await settings.testConnection({
    organisationId: requiredText(formData, 'organisationId')
  });
  revalidatePath('/settings/voice');
}

export async function recordGenericFlowTest(
  formData: FormData
): Promise<void> {
  const { settings } = await context();
  await settings.recordGenericFlowTest({
    organisationId: requiredText(formData, 'organisationId'),
    previewSessionToken: requiredText(formData, 'previewSessionToken')
  });
  revalidatePath('/settings/voice');
}

export async function setVoiceEnabled(formData: FormData): Promise<void> {
  const { settings } = await context();
  const confirmation = optionalText(formData, 'confirmation');
  await settings.setEnabled({
    organisationId: requiredText(formData, 'organisationId'),
    enabled: requiredText(formData, 'enabled') === 'true',
    ...(confirmation === null ? {} : { confirmation })
  });
  revalidatePath('/settings/voice');
}
