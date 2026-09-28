'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { getJobQueue } from '../../../server/job-runtime.js';
import { createManualReminderService } from '../../../server/manual-reminder-service.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import { createEscalationService } from './escalation-service.js';

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const context = async () => {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const database = getDatabaseClient().db;
  const clock = { now: () => new Date() };
  return {
    session,
    database,
    clock,
    escalations: createEscalationService({ database, clock })
  };
};

const refreshReminderViews = (customerId: string, invoiceId: string): void => {
  revalidatePath('/escalations');
  revalidatePath('/outbox');
  revalidatePath(`/customers/${customerId}`);
  revalidatePath(`/invoices/${invoiceId}`);
};

export async function completeTask(formData: FormData): Promise<void> {
  const { session, escalations } = await context();
  await escalations.completeTask(session, {
    organisationId: requiredText(formData, 'organisationId'),
    taskId: requiredText(formData, 'taskId'),
    resolutionNote: requiredText(formData, 'resolutionNote')
  });
  revalidatePath('/escalations');
}

export async function sendEscalationSms(formData: FormData): Promise<void> {
  const { session, database, clock } = await context();
  const reminders = createManualReminderService({
    database,
    publisher: await getJobQueue(),
    clock
  });
  const organisationId = requiredText(formData, 'organisationId');
  const customerId = requiredText(formData, 'customerId');
  const invoiceId = requiredText(formData, 'invoiceId');
  await reminders.queue(session, {
    organisationId,
    customerId,
    invoiceId,
    channel: 'SMS',
    message: requiredText(formData, 'message'),
    confirmed: formData.get('confirmed') === 'yes',
    requestId: requiredText(formData, 'requestId'),
    origin: 'ESCALATION'
  });
  refreshReminderViews(customerId, invoiceId);
}

export async function recordCallLinkOpened(
  formData: FormData
): Promise<{ href: string }> {
  const { session, escalations } = await context();
  return escalations.recordCallLinkOpened(session, {
    organisationId: requiredText(formData, 'organisationId'),
    taskId: requiredText(formData, 'taskId')
  });
}
