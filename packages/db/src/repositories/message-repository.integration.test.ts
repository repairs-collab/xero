import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { messageAttempts, organisations, outboundMessages, users } from '../schema/index.js';
import { PostgresMessageRepository } from './message-repository.js';

const database = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(async () => migrateDatabase(database.db));
afterAll(async () => database.pool.end());

async function seedOrganisation() {
  const organisationId = randomUUID();
  const userId = randomUUID();
  await database.db.insert(organisations).values({
    id: organisationId,
    name: 'Outbox test',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await database.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Test Administrator'
  });
  return { organisationId, userId };
}

describe('PostgresMessageRepository direct messages', () => {
  it('queues one stage-less message and retains its exact content', async () => {
    const { organisationId, userId } = await seedOrganisation();
    const repository = new PostgresMessageRepository(database.db);
    const now = new Date('2026-09-28T01:00:00.000Z');
    const input = {
      organisationId,
      channel: 'SMS' as const,
      source: 'TEST_SMS' as const,
      recipientKey: '+61400000000',
      content: 'AccountPulse test message',
      contentHash: 'sha256:test-message',
      actorUserId: userId,
      idempotencyKey: `test-sms:${randomUUID()}`,
      now
    };

    const first = await repository.queueDirect(input);
    const second = await repository.queueDirect(input);
    expect(first.kind).toBe('queued');
    expect(second).toMatchObject({ kind: 'existing', outboundId: first.outboundId });

    const [stored] = await database.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, first.outboundId));
    expect(stored).toMatchObject({
      stageInstanceId: null,
      source: 'TEST_SMS',
      content: 'AccountPulse test message',
      status: 'QUEUED',
      actorUserId: userId
    });
  });

  it('claims and completes a direct message without a reminder stage', async () => {
    const { organisationId, userId } = await seedOrganisation();
    const repository = new PostgresMessageRepository(database.db);
    const now = new Date('2026-09-28T01:30:00.000Z');
    const queued = await repository.queueDirect({
      organisationId,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: '+61400000001',
      content: 'A second test',
      contentHash: 'sha256:second-test',
      actorUserId: userId,
      idempotencyKey: `test-sms:${randomUUID()}`,
      now
    });

    const claim = await repository.claimDirect({
      organisationId,
      outboundId: queued.outboundId,
      provider: 'SINCH',
      now
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('Expected a claimed message');

    await repository.markAccepted({
      organisationId,
      stageInstanceId: null,
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      providerMessageId: 'sinch-test-1',
      now
    });

    const [stored] = await database.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, claim.outboundId));
    const attempts = await database.db
      .select()
      .from(messageAttempts)
      .where(eq(messageAttempts.outboundMessageId, claim.outboundId));
    expect(stored?.status).toBe('ACCEPTED');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.providerMessageId).toBe('sinch-test-1');
  });
});
