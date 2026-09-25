'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ReminderStageChannel } from '@bc5000/domain';

import { createSequenceService, type SequenceDraft, type SequenceDraftStage } from './sequence-service.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

async function context() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  return { session, sequences: createSequenceService({ database: getDatabaseClient().db, clock: { now: () => new Date() } }) };
}

const parseStages = (value: FormDataEntryValue | null): SequenceDraftStage[] => {
  if (typeof value !== 'string') throw new Error('Stages are required');
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Stages must be an array');
  return parsed.map((stage) => {
    if (typeof stage !== 'object' || stage === null) throw new Error('Invalid stage');
    const row = stage as Record<string, unknown>;
    if (typeof row.key !== 'string' || typeof row.offsetDays !== 'number' || !Array.isArray(row.channels)) throw new Error('Invalid stage');
    return { key: row.key, offsetDays: row.offsetDays, channels: row.channels.map(String) as ReminderStageChannel[], ...(typeof row.template === 'string' ? { template: row.template } : {}) };
  });
};

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
};

const draftFrom = (formData: FormData): SequenceDraft => ({
  organisationId: requiredText(formData, 'organisationId'),
  sequenceId: requiredText(formData, 'sequenceId'),
  dailyBasis: formData.get('dailyBasis') === 'CALENDAR_DAYS' ? 'CALENDAR_DAYS' : 'BUSINESS_DAYS',
  smsAggregation: formData.get('smsAggregation') === 'PER_INVOICE' ? 'PER_INVOICE' : 'CONSOLIDATED_CUSTOMER',
  sendTime: requiredText(formData, 'sendTime'),
  socialWindowStart: requiredText(formData, 'socialWindowStart'),
  socialWindowEnd: requiredText(formData, 'socialWindowEnd'),
  minimumBalance: requiredText(formData, 'minimumBalance'),
  maxSmsSegments: Number(formData.get('maxSmsSegments')),
  xeroEmailAfterSmsOptOut: formData.get('xeroEmailAfterSmsOptOut') === 'on',
  allowedCurrencies: requiredText(formData, 'allowedCurrencies').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),
  exclusions: [],
  stages: parseStages(formData.get('stages'))
});

export async function saveSequenceDraft(formData: FormData): Promise<void> {
  const { session, sequences } = await context();
  const draft = draftFrom(formData);
  await sequences.saveSequenceDraft(session, draft);
  revalidatePath(`/sequences/${draft.sequenceId}`);
}

export async function activateSequenceVersion(formData: FormData): Promise<void> {
  const { session, sequences } = await context();
  const draft = draftFrom(formData);
  await sequences.activateSequenceVersion(session, draft);
  revalidatePath('/');
  redirect(`/sequences/${draft.sequenceId}?activated=1`);
}

export async function setSequenceMode(formData: FormData): Promise<void> {
  const { session, sequences } = await context();
  const sequenceId = requiredText(formData, 'sequenceId');
  await sequences.setSequenceMode(session, { organisationId: requiredText(formData, 'organisationId'), sequenceId, mode: formData.get('mode') === 'AUTOMATIC' ? 'AUTOMATIC' : 'REVIEW' });
  revalidatePath(`/sequences/${sequenceId}`);
}

export async function createStandardSequence(formData: FormData): Promise<void> {
  const { session, sequences } = await context();
  const result = await sequences.createStandardSequence(session, {
    organisationId: requiredText(formData, 'organisationId')
  });
  revalidatePath('/');
  revalidatePath('/sequences');
  redirect(`/sequences/${result.sequenceId}`);
}
