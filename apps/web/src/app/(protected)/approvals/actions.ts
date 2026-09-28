'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { createApprovalService } from './approval-service.js';
import { getJobQueue } from '../../../server/job-runtime.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import { createReminderWhitelistService } from '../../../server/reminder-whitelist-service.js';

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

export async function addApprovalTargetToWhitelist(
  formData: FormData
): Promise<void> {
  if (formData.get('confirmed') !== 'yes') {
    throw new Error('REMINDER_WHITELIST_CONFIRMATION_REQUIRED');
  }
  const { session } = await service();
  const queue = await getJobQueue();
  const whitelist = createReminderWhitelistService({
    database: getDatabaseClient().db,
    publisher: queue,
    clock: { now: () => new Date() }
  });
  const organisationId = requiredText(formData, 'organisationId');
  const contactId = requiredText(formData, 'contactId');
  const scope = requiredText(formData, 'scope');
  if (scope !== 'CLIENT' && scope !== 'INVOICE') {
    throw new Error('REMINDER_WHITELIST_SCOPE_INVALID');
  }
  const rawInvoiceId = formData.get('invoiceId');
  const invoiceId =
    typeof rawInvoiceId === 'string' && rawInvoiceId.trim() !== ''
      ? rawInvoiceId.trim()
      : undefined;
  const rawReason = formData.get('reason');
  const reason =
    typeof rawReason === 'string' && rawReason.trim() !== ''
      ? rawReason.trim()
      : undefined;
  await whitelist.add(session, {
    organisationId,
    contactId,
    scope,
    ...(invoiceId === undefined ? {} : { invoiceId }),
    ...(reason === undefined ? {} : { reason })
  });
  revalidatePath('/approvals');
  revalidatePath('/escalations');
  revalidatePath('/outbox');
  revalidatePath('/settings/reminder-whitelist');
  revalidatePath(`/customers/${contactId}`);
  if (invoiceId !== undefined) revalidatePath(`/invoices/${invoiceId}`);
}
