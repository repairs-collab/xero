import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDatabase,
  messageAttempts,
  migrateDatabase,
  organisations,
  outboundMessages,
  suppressions
} from '@bc5000/db';
import {
  SinchPermanentSubmissionFailure,
  SinchUnknownSubmissionOutcome
} from '@bc5000/integrations/sinch';

import { executeTestSms } from '../src/handlers/test-sms-execute.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-28T03:15:00.000Z');
const number = '+61400000001';

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedTestSms(options: {
  sendMode?: 'dry-run' | 'live';
  allowlisted?: boolean;
  suppressed?: boolean;
} = {}) {
  const organisationId = randomUUID();
  const outboundMessageId = randomUUID();
  const content = 'Exact AccountPulse test message';
  const sendMode = options.sendMode ?? 'live';
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Test SMS execution',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode,
    liveSendAcknowledged: sendMode === 'live',
    recipientAllowlist: options.allowlisted === false ? [] : [number]
  });
  await client.db.insert(outboundMessages).values({
    id: outboundMessageId,
    organisationId,
    channel: 'SMS',
    source: 'TEST_SMS',
    recipientKey: number,
    content,
    contentHash: 'hash',
    status: 'QUEUED',
    idempotencyKey: `test-sms:${randomUUID()}`,
    queuedAt: now,
    updatedAt: now
  });
  if (options.suppressed) {
    await client.db.insert(suppressions).values({
      organisationId,
      channel: 'SMS',
      normalisedDestination: number,
      source: 'SINCH_OPT_OUT',
      reason: 'STOP reply',
      consentState: 'SUPPRESSED',
      recordedAt: now
    });
  }
  return { organisationId, outboundMessageId, content };
}

const dependencies = (sendSms = vi.fn()) => ({
  database: client.db,
  clock: { now: () => now },
  sinch: { sendSms },
  callbackUrl: 'https://example.invalid/api/webhooks/sinch'
});

describe('test SMS execution', () => {
  it('records a dry run when the destination is outside the technical allowlist', async () => {
    const seeded = await seedTestSms({ allowlisted: false });
    const sendSms = vi.fn();

    await expect(executeTestSms(dependencies(sendSms), seeded)).resolves.toEqual({
      kind: 'dry-run'
    });
    expect(sendSms).not.toHaveBeenCalled();
    const [message] = await client.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, seeded.outboundMessageId));
    const attempts = await client.db
      .select()
      .from(messageAttempts)
      .where(eq(messageAttempts.outboundMessageId, seeded.outboundMessageId));
    expect(message?.status).toBe('DRY_RUN');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('DRY_RUN');
  });

  it('cancels a suppressed destination immediately before sending', async () => {
    const seeded = await seedTestSms({ suppressed: true });
    const sendSms = vi.fn();

    await expect(executeTestSms(dependencies(sendSms), seeded)).resolves.toEqual({
      kind: 'cancelled',
      reason: 'SUPPRESSED'
    });
    expect(sendSms).not.toHaveBeenCalled();
    const [message] = await client.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, seeded.outboundMessageId));
    expect(message).toMatchObject({
      status: 'CANCELLED',
      failureReason: 'SUPPRESSED:SINCH_OPT_OUT'
    });
  });

  it('submits exact content once and returns the stored accepted outcome', async () => {
    const seeded = await seedTestSms();
    const sendSms = vi.fn(() =>
      Promise.resolve({
        kind: 'accepted' as const,
        messageId: 'sinch-test-1',
        status: 'ACCEPTED'
      })
    );
    const input = dependencies(sendSms);

    const first = await executeTestSms(input, seeded);
    const second = await executeTestSms(input, seeded);

    expect(first).toEqual({ kind: 'sent', providerMessageId: 'sinch-test-1' });
    expect(second).toEqual({ kind: 'sent', providerMessageId: 'sinch-test-1' });
    expect(sendSms).toHaveBeenCalledOnce();
    expect(sendSms).toHaveBeenCalledWith({
      destinationNumber: number,
      content: seeded.content,
      callbackUrl: 'https://example.invalid/api/webhooks/sinch',
      metadata: {
        organisationId: seeded.organisationId,
        outboundMessageId: seeded.outboundMessageId
      }
    });
    const attempts = await client.db
      .select()
      .from(messageAttempts)
      .where(eq(messageAttempts.outboundMessageId, seeded.outboundMessageId));
    expect(attempts).toHaveLength(1);
  });

  it('records known rejection and unknown outcome without resubmitting', async () => {
    const rejected = await seedTestSms();
    const rejectionSend = vi.fn(() =>
      Promise.reject(new SinchPermanentSubmissionFailure('invalid sender'))
    );
    await expect(
      executeTestSms(dependencies(rejectionSend), rejected)
    ).resolves.toEqual({ kind: 'rejected', reason: 'PROVIDER_REJECTED' });

    const unknown = await seedTestSms();
    const unknownSend = vi.fn(() =>
      Promise.reject(new SinchUnknownSubmissionOutcome())
    );
    const unknownDependencies = dependencies(unknownSend);
    await expect(executeTestSms(unknownDependencies, unknown)).resolves.toEqual({
      kind: 'unknown'
    });
    await expect(executeTestSms(unknownDependencies, unknown)).resolves.toEqual({
      kind: 'unknown'
    });
    expect(unknownSend).toHaveBeenCalledOnce();
  });

  it('rejects an outbound ID owned by another organisation', async () => {
    const seeded = await seedTestSms();
    const sendSms = vi.fn();

    await expect(
      executeTestSms(dependencies(sendSms), {
        organisationId: randomUUID(),
        outboundMessageId: seeded.outboundMessageId
      })
    ).rejects.toThrow('TEST_SMS_NOT_FOUND');
    expect(sendSms).not.toHaveBeenCalled();
  });
});
