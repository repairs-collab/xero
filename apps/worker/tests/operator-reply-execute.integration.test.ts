import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { contacts, conversations, createDatabase, migrateDatabase, operatorReplies, organisations, users } from '@bc5000/db';

import { executeOperatorReply } from '../src/handlers/operator-reply-execute.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T02:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedReply(sendMode: 'dry-run' | 'live') {
  const organisationId = randomUUID(); const userId = randomUUID(); const contactId = randomUUID(); const conversationId = randomUUID(); const replyId = randomUUID(); const number = '+61400000001';
  await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Reply execution', timeZone: 'Australia/Sydney', baseCurrency: 'AUD', sendMode, liveSendAcknowledged: sendMode === 'live', recipientAllowlist: sendMode === 'live' ? [number] : [] });
  await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Operator' });
  await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Customer' });
  await client.db.insert(conversations).values({ id: conversationId, organisationId, contactId, normalisedNumber: number, lastMessageAt: now });
  await client.db.insert(operatorReplies).values({ id: replyId, organisationId, conversationId, actorUserId: userId, content: 'Thanks, noted.', contentHash: 'hash', status: 'PENDING', idempotencyKey: `operator-reply:${replyId}`, createdAt: now, updatedAt: now });
  return { organisationId, replyId };
}

describe('operator reply execution', () => {
  it('honours dry-run safety without calling Sinch', async () => {
    const seeded = await seedReply('dry-run'); const sendSms = vi.fn();
    const outcome = await executeOperatorReply({ database: client.db, clock: { now: () => now }, sinch: { sendSms }, callbackUrl: 'https://example.invalid/sinch' }, seeded);
    const [reply] = await client.db.select().from(operatorReplies).where(eq(operatorReplies.id, seeded.replyId));
    expect(outcome).toEqual({ kind: 'dry-run' }); expect(sendSms).not.toHaveBeenCalled(); expect(reply?.status).toBe('DRY_RUN');
  });

  it('sends an allowlisted live reply once', async () => {
    const seeded = await seedReply('live'); const sendSms = vi.fn(() => Promise.resolve({ kind: 'accepted' as const, messageId: 'sinch-1', status: 'ACCEPTED' })); const dependencies = { database: client.db, clock: { now: () => now }, sinch: { sendSms }, callbackUrl: 'https://example.invalid/sinch' };
    const first = await executeOperatorReply(dependencies, seeded); const second = await executeOperatorReply(dependencies, seeded);
    expect(first).toMatchObject({ kind: 'sent', providerMessageId: 'sinch-1' }); expect(second).toMatchObject({ kind: 'sent', providerMessageId: 'sinch-1' }); expect(sendSms).toHaveBeenCalledOnce();
  });
});
