'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import type { ReminderStageChannel } from '@bc5000/domain';

import { getDatabaseClient, requireWebAcceptedSession } from '../../../server/runtime.js';
import {
  createSequenceService,
  type SequenceDraft,
  type SequenceDraftStage
} from './sequence-service.js';
import { SequenceScheduleValidationError, type SequenceScheduleIssue } from './sms-schedule.js';

async function context() {
  const session = await requireWebAcceptedSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  return {
    session,
    sequences: createSequenceService({
      database: getDatabaseClient().db,
      clock: { now: () => new Date() }
    })
  };
}

const parseStages = (
  value: FormDataEntryValue | null
): SequenceDraftStage[] => {
  if (typeof value !== 'string') throw new Error('Stages are required');
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Stages must be an array');
  return parsed.map((stage) => {
    if (typeof stage !== 'object' || stage === null) {
      throw new Error('Invalid stage');
    }
    const row = stage as Record<string, unknown>;
    if (
      typeof row.key !== 'string' ||
      typeof row.offsetDays !== 'number' ||
      !Array.isArray(row.channels)
    ) {
      throw new Error('Invalid stage');
    }
    return {
      key: row.key,
      offsetDays: row.offsetDays,
      channels: row.channels.map(String) as ReminderStageChannel[],
      ...(typeof row.template === 'string' ? { template: row.template } : {})
    };
  });
};

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

const draftFrom = (formData: FormData): SequenceDraft => {
  const kind = formData.get('kind') === 'VOICE' ? 'VOICE' : 'MESSAGING';
  return {
    organisationId: requiredText(formData, 'organisationId'),
    sequenceId: requiredText(formData, 'sequenceId'),
    kind,
    dailyBasis:
      formData.get('dailyBasis') === 'CALENDAR_DAYS'
        ? 'CALENDAR_DAYS'
        : 'BUSINESS_DAYS',
    smsAggregation:
      formData.get('smsAggregation') === 'PER_INVOICE'
        ? 'PER_INVOICE'
        : 'CONSOLIDATED_CUSTOMER',
    sendTime: requiredText(formData, 'sendTime'),
    socialWindowStart: requiredText(formData, 'socialWindowStart'),
    socialWindowEnd: requiredText(formData, 'socialWindowEnd'),
    minimumBalance: requiredText(formData, 'minimumBalance'),
    maxSmsSegments: Number(formData.get('maxSmsSegments') ?? 3),
    xeroEmailAfterSmsOptOut:
      formData.get('xeroEmailAfterSmsOptOut') === 'on',
    ...(kind === 'VOICE'
      ? {
          maxCallsPerRun: Number(formData.get('maxCallsPerRun')),
          cooldownSeconds: Number(formData.get('cooldownSeconds'))
        }
      : {}),
    allowedCurrencies: requiredText(formData, 'allowedCurrencies')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
    exclusions: [],
    stages: parseStages(formData.get('stages'))
  };
};

const tabFor = (formData: FormData): 'messaging' | 'voice' =>
  formData.get('tab') === 'voice' ? 'voice' : 'messaging';

function scheduleIssue(error: unknown): SequenceScheduleIssue {
  if (error instanceof SequenceScheduleValidationError) return error.issue;
  throw error;
}

export async function saveSequenceVersion(
  _previousIssue: SequenceScheduleIssue | null,
  formData: FormData
): Promise<SequenceScheduleIssue | null> {
  const { session, sequences } = await context();
  const draft = draftFrom(formData);
  const activate = formData.get('versionAction') === 'activate';
  try {
    if (activate) await sequences.activateSequenceVersion(session, draft);
    else await sequences.saveSequenceDraft(session, draft);
  } catch (error) {
    return scheduleIssue(error);
  }
  revalidatePath(`/sequences/${draft.sequenceId}`);
  if (activate) {
    revalidatePath('/');
    redirect(`/sequences/${draft.sequenceId}?tab=${tabFor(formData)}&activated=1`);
  }
  return null;
}

export async function setSequenceMode(
  _previousIssue: SequenceScheduleIssue | null,
  formData: FormData
): Promise<SequenceScheduleIssue | null> {
  const { session, sequences } = await context();
  const sequenceId = requiredText(formData, 'sequenceId');
  try {
    await sequences.setSequenceMode(session, {
      organisationId: requiredText(formData, 'organisationId'),
      sequenceId,
      mode: formData.get('mode') === 'AUTOMATIC' ? 'AUTOMATIC' : 'REVIEW'
    });
  } catch (error) {
    return scheduleIssue(error);
  }
  revalidatePath(`/sequences/${sequenceId}`);
  return null;
}

export async function setSequenceEnabled(
  _previousIssue: SequenceScheduleIssue | null,
  formData: FormData
): Promise<SequenceScheduleIssue | null> {
  const { session, sequences } = await context();
  const sequenceId = requiredText(formData, 'sequenceId');
  try {
    await sequences.setSequenceEnabled(session, {
      organisationId: requiredText(formData, 'organisationId'),
      sequenceId,
      enabled: formData.get('enabled') === 'true'
    });
  } catch (error) {
    return scheduleIssue(error);
  }
  revalidatePath('/sequences');
  revalidatePath(`/sequences/${sequenceId}`);
  return null;
}

export async function createStandardSequence(
  formData: FormData
): Promise<void> {
  const { session, sequences } = await context();
  const result = await sequences.createStandardSequence(session, {
    organisationId: requiredText(formData, 'organisationId')
  });
  revalidatePath('/');
  revalidatePath('/sequences');
  redirect(`/sequences/${result.sequenceId}?tab=messaging`);
}

export async function createStandardVoiceSequence(
  formData: FormData
): Promise<void> {
  const { session, sequences } = await context();
  const result = await sequences.createStandardVoiceSequence(session, {
    organisationId: requiredText(formData, 'organisationId')
  });
  revalidatePath('/');
  revalidatePath('/sequences');
  redirect(`/sequences/${result.sequenceId}?tab=voice`);
}
