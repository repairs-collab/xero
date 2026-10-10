'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { PostgresVoiceCallRepository } from '@bc5000/db/web';

import { getJobQueue } from '../../../../../server/job-runtime.js';
import { createServerClock } from '../../../../../server/clock.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../../server/runtime.js';
import { createVoiceCallService } from './voice-call-service.js';

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const requiredInteger = (formData: FormData, name: string): number => {
  const value = Number(requiredText(formData, name));
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
};

async function context() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const database = getDatabaseClient().db;
  return createVoiceCallService({
    database,
    repository: new PostgresVoiceCallRepository(database),
    publisher: await getJobQueue(),
    session,
    clock: createServerClock(),
    holidays: { list: () => [] }
  });
}

export async function prepareVoiceReminder(formData: FormData): Promise<void> {
  const organisationId = requiredText(formData, 'organisationId');
  const customerId = requiredText(formData, 'customerId');
  const idempotencyKey = requiredText(formData, 'idempotencyKey');
  const service = await context();

  await service.prepare({ organisationId, customerId, idempotencyKey });
  redirect(
    `/customers/${encodeURIComponent(customerId)}?voice=${encodeURIComponent(idempotencyKey)}`
  );
}

export async function approveVoiceReminder(formData: FormData): Promise<void> {
  const organisationId = requiredText(formData, 'organisationId');
  const customerId = requiredText(formData, 'customerId');
  const service = await context();

  await service.approveAndQueue({
    organisationId,
    customerId,
    voiceCallId: requiredText(formData, 'voiceCallId'),
    idempotencyKey: requiredText(formData, 'idempotencyKey'),
    callFlowVersion: requiredInteger(formData, 'callFlowVersion'),
    callFlowHash: requiredText(formData, 'callFlowHash'),
    approvedFactsHash: requiredText(formData, 'approvedFactsHash'),
    confirmed: formData.get('confirmed') === 'yes'
  });

  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${encodeURIComponent(customerId)}?voiceQueued=1`);
}
