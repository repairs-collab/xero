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
import { processOptOut } from '../src/services/inbound-reply-service.js';

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
  rolloutScope?: 'CONTROLLED' | 'CUSTOMER';
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
    rolloutScope: options.rolloutScope ?? 'CONTROLLED',
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const waitUntilAsync = async (
  condition: () => Promise<boolean>
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test SMS state');
};

describe('test SMS execution', () => {
  it('records a dry run when the destination is outside the technical allowlist', async () => {
    const seeded = await seedTestSms({
      allowlisted: false,
      rolloutScope: 'CUSTOMER'
    });
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

  it('keeps rollout changes and opt-outs pending until an in-flight provider submission finishes', async () => {
    const seeded = await seedTestSms();
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const sendSms = vi.fn(async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return {
        kind: 'accepted' as const,
        messageId: 'sinch-atomic-send',
        status: 'ACCEPTED'
      };
    });

    const execution = executeTestSms(dependencies(sendSms), seeded);
    await providerStarted.promise;

    let rolloutChangeFinished = false;
    const rolloutChange = client.db
      .transaction(async (transaction) => {
        await transaction
          .update(organisations)
          .set({ maintenanceMode: true })
          .where(eq(organisations.id, seeded.organisationId));
      })
      .then(() => {
        rolloutChangeFinished = true;
      });
    let optOutFinished = false;
    const optOut = processOptOut(client.db, seeded.organisationId, {
      kind: 'opt-out',
      notificationId: randomUUID(),
      from: number,
      to: '+61400000002',
      receivedAt: '2026-09-28T03:16:00.000Z',
      content: 'STOP'
    }).then(() => {
      optOutFinished = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(rolloutChangeFinished).toBe(false);
    expect(optOutFinished).toBe(false);

    releaseProvider.resolve();
    await expect(execution).resolves.toEqual({
      kind: 'sent',
      providerMessageId: 'sinch-atomic-send'
    });
    await Promise.all([rolloutChange, optOut]);
    expect(rolloutChangeFinished).toBe(true);
    expect(optOutFinished).toBe(true);
  });

  it('re-reads maintenance after claiming and prevents the Test SMS provider call', async () => {
    const seeded = await seedTestSms();
    const sendSms = vi.fn(() =>
      Promise.resolve({
        kind: 'accepted' as const,
        messageId: 'too-late',
        status: 'ACCEPTED'
      })
    );
    const locked = deferred();
    const release = deferred();
    const policyChange = client.db.transaction(async (transaction) => {
      await transaction
        .update(organisations)
        .set({ maintenanceMode: true })
        .where(eq(organisations.id, seeded.organisationId));
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const execution = executeTestSms(dependencies(sendSms), seeded);
    try {
      await waitUntilAsync(async () => {
        if (sendSms.mock.calls.length > 0) return true;
        const [message] = await client.db
          .select({ status: outboundMessages.status })
          .from(outboundMessages)
          .where(eq(outboundMessages.id, seeded.outboundMessageId));
        return message?.status === 'SENDING';
      });
      expect(sendSms).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await policyChange;
    }

    await expect(execution).resolves.toEqual({
      kind: 'cancelled',
      reason: 'OPERATIONAL_MAINTENANCE'
    });
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
