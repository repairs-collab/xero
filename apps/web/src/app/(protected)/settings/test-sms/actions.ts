'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { authorise, AuthorizationFailure } from '@bc5000/auth';

import { getJobQueue } from '../../../../server/job-runtime.js';
import { getDatabaseClient, requireWebAcceptedSession } from '../../../../server/runtime.js';
import { loadSettingsWorkspaceEdition } from '../settings-workspace.js';
import { createTestSmsService } from './test-sms-service.js';

const requiredValue = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

export async function queueTestSms(formData: FormData): Promise<void> {
  const session = await requireWebAcceptedSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = requiredValue(formData, 'organisationId').trim();
  authorise(session, 'message.test-sms', organisationId);
  const database = getDatabaseClient().db;
  if (await loadSettingsWorkspaceEdition(database, organisationId) !== 'INTERNAL_LEGACY') {
    throw new AuthorizationFailure();
  }
  const service = createTestSmsService({
    database,
    publisher: await getJobQueue(),
    clock: { now: () => new Date() }
  });
  await service.queue(session, {
    organisationId,
    destination: requiredValue(formData, 'destination'),
    content: requiredValue(formData, 'content'),
    confirmed: formData.get('confirmed') === 'yes',
    requestId: requiredValue(formData, 'requestId').trim()
  });
  revalidatePath('/outbox');
  redirect('/settings/test-sms?queued=yes');
}
