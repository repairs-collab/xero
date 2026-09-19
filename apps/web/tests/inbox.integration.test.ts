import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { contactChannels, contacts, conversations, createDatabase, migrateDatabase, operatorReplies, organisations, pauses, suppressions, users } from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { createInboxService } from '../src/app/(protected)/inbox/inbox-service.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T02:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedConversation(suppressed = false) {
  const organisationId = randomUUID(); const userId = randomUUID(); const contactId = randomUUID(); const conversationId = randomUUID(); const number = '+61400000001';
  await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Inbox test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
  await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Operator' });
  await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Customer' });
  await client.db.insert(contactChannels).values({ organisationId, contactId, kind: 'SMS', sourceValue: '0400 000 001', normalisedValue: number });
  await client.db.insert(conversations).values({ id: conversationId, organisationId, contactId, normalisedNumber: number, unreadCount: 1, lastMessageAt: now });
  await client.db.insert(pauses).values({ organisationId, kind: 'REPLY', scope: 'customer', contactId, active: true, reason: 'Customer replied', startedAt: now });
  if (suppressed) await client.db.insert(suppressions).values({ organisationId, channel: 'SMS', normalisedDestination: number, source: 'SINCH_OPT_OUT', reason: 'STOP reply', consentState: 'SUPPRESSED', recordedAt: now });
  const session: AppSession = { userId, cognitoSubject: randomUUID(), displayName: 'Operator', expiresAt: '2026-09-18T10:00:00Z', memberships: [{ organisationId, role: 'OPERATOR', active: true }] };
  return { organisationId, userId, contactId, conversationId, session };
}

const publisher = () => ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

describe('shared inbox', () => {
  it('keeps chasing paused after an Operator reply until explicit resume', async () => {
    const seeded = await seedConversation(); const jobs = publisher();
    const service = createInboxService({ database: client.db, publisher: jobs, clock: { now: () => now } });
    const result = await service.sendOperatorReply(seeded.session, { organisationId: seeded.organisationId, conversationId: seeded.conversationId, content: 'Thanks, we have noted that.' });
    const [activePause] = await client.db.select().from(pauses).where(and(eq(pauses.organisationId, seeded.organisationId), eq(pauses.contactId, seeded.contactId), eq(pauses.active, true)));
    const [reply] = await client.db.select().from(operatorReplies).where(eq(operatorReplies.id, result.replyId));
    expect(activePause).toMatchObject({ kind: 'REPLY' });
    expect(reply).toMatchObject({ status: 'PENDING', content: 'Thanks, we have noted that.' });
    expect(jobs.publish).toHaveBeenCalledOnce();
  });

  it('blocks an Operator reply to a suppressed number and explains the source', async () => {
    const seeded = await seedConversation(true);
    const service = createInboxService({ database: client.db, publisher: publisher(), clock: { now: () => now } });
    await expect(service.sendOperatorReply(seeded.session, { organisationId: seeded.organisationId, conversationId: seeded.conversationId, content: 'Hello' })).rejects.toThrow('SMS_SUPPRESSED:SINCH_OPT_OUT');
  });
});
