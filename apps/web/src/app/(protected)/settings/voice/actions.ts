'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  organisationVoiceSettings,
  PostgresVoiceCallRepository
} from '@bc5000/db/web';

import { getJobQueue } from '../../../../server/job-runtime.js';
import {
  getDatabaseClient,
  getVoiceProviderTester,
  requireWebSession,
  verifyVoicePreviewSession
} from '../../../../server/runtime.js';
import { createVoiceSettingsService } from './voice-settings.js';
import {
  runSetAutomaticVoiceCallsAction,
  runSetVoiceEnabledAction,
  type VoiceSettingsActionState
} from './voice-settings-enable-action.js';
import { createVoiceTestCallService } from './voice-test-call-service.js';

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
    }),
    testCalls: createVoiceTestCallService({
      database,
      repository: new PostgresVoiceCallRepository(database),
      publisher: await getJobQueue(),
      session,
      clock: { now: () => new Date() },
      holidays: { list: () => [] }
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
  if (secretReference === undefined || secretReference === null) {
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

export async function setVoiceEnabled(
  _previousState: VoiceSettingsActionState,
  formData: FormData
): Promise<VoiceSettingsActionState> {
  const { settings } = await context();
  const confirmation = optionalText(formData, 'confirmation');
  return runSetVoiceEnabledAction(
    {
      settings,
      revalidate: () => revalidatePath('/settings/voice')
    },
    {
      organisationId: requiredText(formData, 'organisationId'),
      enabled: requiredText(formData, 'enabled') === 'true',
      ...(confirmation === null ? {} : { confirmation })
    }
  );
}

export async function setAutomaticVoiceCalls(
  _previousState: VoiceSettingsActionState,
  formData: FormData
): Promise<VoiceSettingsActionState> {
  const { settings } = await context();
  const confirmation = optionalText(formData, 'confirmation');
  return runSetAutomaticVoiceCallsAction(
    {
      settings,
      revalidate: () => {
        revalidatePath('/settings/voice');
        revalidatePath('/sequences');
        revalidatePath('/approvals');
      }
    },
    {
      organisationId: requiredText(formData, 'organisationId'),
      enabled: requiredText(formData, 'enabled') === 'true',
      ...(confirmation === null ? {} : { confirmation })
    }
  );
}

export async function prepareVoiceTestCall(formData: FormData): Promise<void> {
  const { testCalls } = await context();
  const result = await testCalls.prepare({
    organisationId: requiredText(formData, 'organisationId'),
    invoiceNumber: requiredText(formData, 'invoiceNumber'),
    testNumber: requiredText(formData, 'testNumber'),
    idempotencyKey: requiredText(formData, 'idempotencyKey')
  });
  redirect(
    `/settings/voice?testVoiceCall=${encodeURIComponent(result.voiceCallId)}`
  );
}

export async function approveVoiceTestCall(formData: FormData): Promise<void> {
  const { testCalls } = await context();
  await testCalls.approveAndQueue({
    organisationId: requiredText(formData, 'organisationId'),
    voiceCallId: requiredText(formData, 'voiceCallId'),
    idempotencyKey: requiredText(formData, 'idempotencyKey'),
    confirmed: formData.get('confirmed') === 'yes'
  });
  revalidatePath('/settings/voice');
  redirect('/settings/voice?testVoiceQueued=1');
}
