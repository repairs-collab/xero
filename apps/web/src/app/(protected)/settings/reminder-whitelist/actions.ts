'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import type { ReminderWhitelistScope } from '@bc5000/db/web';

import { getJobQueue } from '../../../../server/job-runtime.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import { createReminderWhitelistService } from '../../../../server/reminder-whitelist-service.js';

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const optionalText = (formData: FormData, name: string): string | undefined => {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
};

const requireConfirmation = (formData: FormData): void => {
  if (formData.get('confirmed') !== 'yes') {
    throw new Error('REMINDER_WHITELIST_CONFIRMATION_REQUIRED');
  }
};

const getService = async () => ({
  session: await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  ),
  whitelist: createReminderWhitelistService({
    database: getDatabaseClient().db,
    publisher: await getJobQueue(),
    clock: { now: () => new Date() }
  })
});

const revalidateWhitelistViews = (
  contactId?: string,
  invoiceId?: string
): void => {
  revalidatePath('/approvals');
  revalidatePath('/escalations');
  revalidatePath('/outbox');
  revalidatePath('/settings/reminder-whitelist');
  if (contactId !== undefined) revalidatePath(`/customers/${contactId}`);
  if (invoiceId !== undefined) revalidatePath(`/invoices/${invoiceId}`);
};

export async function addWhitelistEntry(formData: FormData): Promise<void> {
  requireConfirmation(formData);
  const scope = requiredText(formData, 'scope') as ReminderWhitelistScope;
  if (scope !== 'CLIENT' && scope !== 'INVOICE') {
    throw new Error('REMINDER_WHITELIST_SCOPE_INVALID');
  }
  const organisationId = requiredText(formData, 'organisationId');
  const contactId = requiredText(formData, 'contactId');
  const invoiceId = optionalText(formData, 'invoiceId');
  const { session, whitelist } = await getService();
  await whitelist.add(session, {
    organisationId,
    contactId,
    scope,
    ...(invoiceId === undefined ? {} : { invoiceId }),
    ...(optionalText(formData, 'reason') === undefined
      ? {}
      : { reason: optionalText(formData, 'reason')! })
  });
  revalidateWhitelistViews(contactId, invoiceId);
}

export async function removeWhitelistEntry(formData: FormData): Promise<void> {
  requireConfirmation(formData);
  const organisationId = requiredText(formData, 'organisationId');
  const { session, whitelist } = await getService();
  await whitelist.remove(session, {
    organisationId,
    entryId: requiredText(formData, 'entryId')
  });
  revalidateWhitelistViews();
}
