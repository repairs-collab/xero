'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getJobQueue } from '../../../../server/job-runtime.js';
import { getDatabaseClient, requireWebSession } from '../../../../server/runtime.js';
import { createTestSmsService } from './test-sms-service.js';

const requiredValue = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

export async function queueTestSms(formData: FormData): Promise<void> {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const service = createTestSmsService({
    database: getDatabaseClient().db,
    publisher: await getJobQueue(),
    clock: { now: () => new Date() }
  });
  await service.queue(session, {
    organisationId: requiredValue(formData, 'organisationId').trim(),
    destination: requiredValue(formData, 'destination'),
    content: requiredValue(formData, 'content'),
    confirmed: formData.get('confirmed') === 'yes',
    requestId: requiredValue(formData, 'requestId').trim()
  });
  revalidatePath('/outbox');
  redirect('/settings/test-sms?queued=yes');
}
