'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { createApprovalService } from './approval-service.js';
import { getJobQueue } from '../../../server/job-runtime.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

async function service() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  return { session, approvals: createApprovalService({ database: getDatabaseClient().db, publisher: await getJobQueue(), clock: { now: () => new Date() } }) };
}

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
};

export async function approveReminder(formData: FormData): Promise<void> {
  const { session, approvals } = await service();
  await approvals.approveReminder(session, { organisationId: requiredText(formData, 'organisationId'), approvalId: requiredText(formData, 'approvalId') });
  revalidatePath('/approvals');
}

export async function rejectReminder(formData: FormData): Promise<void> {
  const { session, approvals } = await service();
  await approvals.rejectReminder(session, { organisationId: requiredText(formData, 'organisationId'), approvalId: requiredText(formData, 'approvalId') });
  revalidatePath('/approvals');
}

export async function snoozeReminder(formData: FormData): Promise<void> {
  const { session, approvals } = await service();
  const until = new Date(requiredText(formData, 'until'));
  if (!Number.isFinite(until.getTime())) throw new Error('A valid snooze date is required');
  await approvals.snoozeReminder(session, { organisationId: requiredText(formData, 'organisationId'), approvalId: requiredText(formData, 'approvalId'), until });
  revalidatePath('/approvals');
}

export async function bulkApproveReminders(formData: FormData): Promise<void> {
  const { session, approvals } = await service();
  await approvals.bulkApprove(session, { organisationId: requiredText(formData, 'organisationId'), approvalIds: formData.getAll('approvalId').filter((value): value is string => typeof value === 'string') });
  revalidatePath('/approvals');
}
