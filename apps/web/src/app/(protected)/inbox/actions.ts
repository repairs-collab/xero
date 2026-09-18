'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { createInboxService } from './inbox-service.js';
import { getJobQueue } from '../../../server/job-runtime.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

const requiredText = (formData: FormData, name: string): string => { const value = formData.get(name); if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`); return value; };

export async function sendOperatorReply(formData: FormData): Promise<void> {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  const inbox = createInboxService({ database: getDatabaseClient().db, publisher: await getJobQueue(), clock: { now: () => new Date() } });
  const conversationId = requiredText(formData, 'conversationId');
  await inbox.sendOperatorReply(session, { organisationId: requiredText(formData, 'organisationId'), conversationId, content: requiredText(formData, 'content') });
  revalidatePath(`/inbox/${conversationId}`);
}
