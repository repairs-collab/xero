import { randomInt, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  organisationOnboarding,
  organisations,
  outboundMessages,
  replyNumberProvisioningRequests,
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  subscriptions
} from '../schema/index.js';
import { PostgresSmsCommerceRepository } from './sms-commerce-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
let clockTime = new Date('2026-11-10T00:00:00.000Z');
const repository = new PostgresSmsCommerceRepository(client.db, { now: () => clockTime });
const periodStart = new Date('2026-11-01T00:00:00.000Z');
const periodEnd = new Date('2026-12-01T00:00:00.000Z');
const now = new Date('2026-11-10T00:00:00.000Z');

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

const seedPaidOrganisation = async (options: {
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
} = {}) => {
  const organisationId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: `SMS commerce ${organisationId}`,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO'
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: 'ACTIVE',
    currentPeriodStart: options.currentPeriodStart ?? periodStart,
    currentPeriodEnd: options.currentPeriodEnd ?? periodEnd
  });
  await client.db.insert(organisationOnboarding).values({ organisationId });
  return organisationId;
};

const seedPoolNumber = async (options: {
  verified?: boolean;
  createdAt?: Date;
  organisationId?: string;
  status?: 'AVAILABLE' | 'RESERVED' | 'READY';
} = {}) => {
  const e164Number = `+614${randomInt(10_000_000, 99_999_999)}`;
  const [number] = await client.db
    .insert(smsNumberPool)
    .values({
      e164Number,
      provider: 'SINCH',
      providerNumberId: randomUUID(),
      providerVerifiedAt: options.verified ? now : null,
      organisationId: options.organisationId,
      status: options.status ?? 'AVAILABLE',
      reservedAt: options.status === 'RESERVED' ? now : null,
      readyAt: options.status === 'READY' ? now : null,
      createdAt: options.createdAt
    })
    .returning({ id: smsNumberPool.id, e164Number: smsNumberPool.e164Number });
  if (number === undefined) throw new Error('number not created');
  return number;
};

const seedOutbound = async (organisationId: string) => {
  const [outbound] = await client.db
    .insert(outboundMessages)
    .values({
      organisationId,
      channel: 'SMS',
      source: 'MANUAL_REMINDER',
      recipientKey: '+61412345678',
      content: 'Please pay your invoice.',
      idempotencyKey: randomUUID()
    })
    .returning({ id: outboundMessages.id });
  if (outbound === undefined) throw new Error('outbound not created');
  return outbound.id;
};

describe('PostgresSmsCommerceRepository', () => {
  it('enforces the cancellation boundary and clears trust on old status-only writes', async () => {
    const organisationId = await seedPaidOrganisation();
    await client.db.update(subscriptions).set({ status: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: now }).where(eq(subscriptions.organisationId, organisationId));
    await expect(client.db.query.subscriptions.findFirst({ where: (table, { eq }) => eq(table.organisationId, organisationId) })).resolves.toMatchObject({ status: 'CANCEL_AT_PERIOD_END', trustedStripeProviderStatus: 'active' });
    await seedPoolNumber({ verified: true, createdAt: new Date(-Date.now()) });
    clockTime = new Date(now.getTime() - 1);
    await expect(repository.reserveAvailableNumber(organisationId, clockTime)).resolves.toMatchObject({ status: 'RESERVED' });
    clockTime = now;
    await expect(repository.reserveAvailableNumber(organisationId, new Date(now.getTime() - 1))).rejects.toThrow('PAID_SUBSCRIPTION_REQUIRED');
    await client.db.update(subscriptions).set({ status: 'CANCEL_AT_PERIOD_END', currentPeriodEnd: periodEnd }).where(eq(subscriptions.organisationId, organisationId));
    await expect(client.db.query.subscriptions.findFirst({ where: (table, { eq }) => eq(table.organisationId, organisationId) })).resolves.toMatchObject({ status: 'INCOMPLETE', trustedStripeProviderStatus: null });
    await expect(repository.reserveAvailableNumber(organisationId, now)).rejects.toThrow('PAID_SUBSCRIPTION_REQUIRED');
  });

  it('does not mark a reserved number ready when the caller time predates the cutoff', async () => {
    const organisationId = await seedPaidOrganisation();
    const number = await seedPoolNumber({ verified: true, organisationId, status: 'RESERVED' });
    await client.db.update(subscriptions).set({ status: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: now }).where(eq(subscriptions.organisationId, organisationId));
    clockTime = now;
    await expect(repository.markNumberReady(organisationId, number.id, new Date(now.getTime() - 1))).rejects.toThrow('PAID_SUBSCRIPTION_REQUIRED');
    await expect(client.db.query.smsNumberPool.findFirst({ where: (table, { eq }) => eq(table.id, number.id) })).resolves.toMatchObject({ status: 'RESERVED' });
  });

  it('does not mark a reserved number ready after a billing downgrade', async () => {
    const organisationId = await seedPaidOrganisation();
    const number = await seedPoolNumber({ verified: true, organisationId, status: 'RESERVED' });
    await client.db.update(subscriptions).set({ status: 'PAST_DUE' }).where(eq(subscriptions.organisationId, organisationId));
    await expect(repository.markNumberReady(organisationId, number.id, now)).rejects.toThrow('PAID_SUBSCRIPTION_REQUIRED');
    await expect(client.db.query.smsNumberPool.findFirst({ where: (table, { eq }) => eq(table.id, number.id) })).resolves.toMatchObject({ status: 'RESERVED' });
  });

  it('skips older unverified numbers and assigns a verified Sinch number', async () => {
    const organisationId = await seedPaidOrganisation();
    const earliest = -Date.now();
    const unverified = await seedPoolNumber({
      createdAt: new Date(earliest - 1_000)
    });
    const poolNumber = await seedPoolNumber({
      verified: true,
      createdAt: new Date(earliest)
    });
    const reserved = await repository.reserveAvailableNumber(
      organisationId,
      now
    );
    expect(reserved).toMatchObject({
      id: poolNumber.id,
      e164Number: poolNumber.e164Number,
      status: 'RESERVED'
    });
    await expect(
      client.db.query.smsNumberPool.findFirst({
        where: (table, { eq }) => eq(table.id, unverified.id)
      })
    ).resolves.toMatchObject({ status: 'AVAILABLE', organisationId: null });
    await repository.markNumberReady(organisationId, poolNumber.id, now);

    await expect(
      repository.findOrganisationIdByDestinationNumber(poolNumber.e164Number)
    ).resolves.toBe(organisationId);
    await expect(
      repository.reserveAvailableNumber(organisationId, now)
    ).resolves.toMatchObject({ id: poolNumber.id, status: 'READY' });
  });

  it('does not claim a pool number while manual provisioning is active', async () => {
    const organisationId = await seedPaidOrganisation();
    const poolNumber = await seedPoolNumber({ verified: true });
    await client.db.insert(replyNumberProvisioningRequests).values({
      organisationId,
      provider: 'SINCH',
      requestKey: `reply-number:${organisationId}:1`,
      attempt: 1,
      status: 'AWAITING_QUOTE',
      createdAt: now,
      updatedAt: now
    });

    await expect(
      repository.reserveAvailableNumber(organisationId, now)
    ).rejects.toThrow('SMS_NUMBER_PROVISIONING_REQUEST_ACTIVE');
    await expect(
      client.db.query.smsNumberPool.findFirst({
        where: (table, { eq }) => eq(table.id, poolNumber.id)
      })
    ).resolves.toMatchObject({ status: 'AVAILABLE', organisationId: null });
  });

  it('reserves and commits final rendered parts idempotently per tenant', async () => {
    const organisationId = await seedPaidOrganisation();
    await seedPoolNumber({ verified: true, createdAt: new Date(-Date.now()) });
    const number = await repository.reserveAvailableNumber(organisationId, now);
    await repository.markNumberReady(organisationId, number.id, now);
    const outboundId = await seedOutbound(organisationId);

    await expect(
      repository.reserveUsage({
        organisationId,
        outboundMessageId: outboundId,
        source: 'MANUAL_REMINDER',
        partCount: 2,
        now
      })
    ).resolves.toMatchObject({ kind: 'reserved', alreadyReserved: false });
    await repository.commitUsage(organisationId, outboundId, now);
    await repository.commitUsage(organisationId, outboundId, now);
    await expect(repository.loadUsage(organisationId)).resolves.toMatchObject({
      committedParts: 2,
      reservedParts: 0,
      includedParts: 2_000
    });

    const blockedOutboundId = await seedOutbound(organisationId);
    await expect(
      repository.reserveUsage({
        organisationId,
        outboundMessageId: blockedOutboundId,
        source: 'MANUAL_REMINDER',
        partCount: 1_999,
        now
      })
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 2_001
    });
  });

  it('resets an annual subscription allowance on clamped monthly boundaries and retries idempotently', async () => {
    const annualStart = new Date('2027-01-31T00:00:00.000Z');
    const annualEnd = new Date('2028-01-31T00:00:00.000Z');
    const secondCycleStart = new Date('2027-02-28T00:00:00.000Z');
    const secondCycleEnd = new Date('2027-03-31T00:00:00.000Z');
    const organisationId = await seedPaidOrganisation({
      currentPeriodStart: annualStart,
      currentPeriodEnd: annualEnd
    });
    await client.db.insert(smsAllowanceSettings).values({
      organisationId,
      includedParts: 2,
      warningPercent: 80
    });
    await seedPoolNumber({
      verified: true,
      createdAt: new Date(-Date.now())
    });
    const number = await repository.reserveAvailableNumber(
      organisationId,
      annualStart
    );
    await repository.markNumberReady(organisationId, number.id, annualStart);

    const firstCycleOutbound = await seedOutbound(organisationId);
    await expect(
      repository.reserveUsage({
        organisationId,
        outboundMessageId: firstCycleOutbound,
        source: 'MANUAL_REMINDER',
        partCount: 2,
        now: new Date('2027-02-27T23:59:59.999Z')
      })
    ).resolves.toMatchObject({ kind: 'reserved', alreadyReserved: false });

    const secondCycleOutbound = await seedOutbound(organisationId);
    const secondCycleReservation = {
      organisationId,
      outboundMessageId: secondCycleOutbound,
      source: 'MANUAL_REMINDER' as const,
      partCount: 2,
      now: secondCycleStart
    };
    await expect(
      repository.reserveUsage(secondCycleReservation)
    ).resolves.toMatchObject({ kind: 'reserved', alreadyReserved: false });
    await expect(
      repository.reserveUsage(secondCycleReservation)
    ).resolves.toMatchObject({ kind: 'reserved', alreadyReserved: true });

    clockTime = secondCycleStart;
    await expect(repository.loadUsage(organisationId)).resolves.toMatchObject({
      billingPeriodStart: secondCycleStart,
      billingPeriodEnd: secondCycleEnd,
      reservedParts: 2,
      remainingParts: 0
    });
    clockTime = now;
  });

  it('hard-caps persisted legacy overage settings at the exact multipart boundary', async () => {
    const organisationId = await seedPaidOrganisation();
    await client.db.insert(smsAllowanceSettings).values({
      organisationId,
      includedParts: 3,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: 10_000,
      overageCentsPerPart: 1
    });
    await seedPoolNumber({ verified: true, createdAt: new Date(-Date.now()) });
    const number = await repository.reserveAvailableNumber(organisationId, now);
    await repository.markNumberReady(organisationId, number.id, now);

    const firstOutboundId = await seedOutbound(organisationId);
    await expect(
      repository.reserveUsage({
        organisationId,
        outboundMessageId: firstOutboundId,
        source: 'MANUAL_REMINDER',
        partCount: 1,
        now
      })
    ).resolves.toMatchObject({ kind: 'reserved', alreadyReserved: false });

    const exactBoundaryOutboundId = await seedOutbound(organisationId);
    await expect(
      repository.reserveUsage({
        organisationId,
        outboundMessageId: exactBoundaryOutboundId,
        source: 'MANUAL_REMINDER',
        partCount: 2,
        now
      })
    ).resolves.toMatchObject({ kind: 'reserved', alreadyReserved: false });

    const crossingOutboundId = await seedOutbound(organisationId);
    await expect(
      repository.reserveUsage({
        organisationId,
        outboundMessageId: crossingOutboundId,
        source: 'MANUAL_REMINDER',
        partCount: 2,
        now
      })
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 5
    });
    await expect(
      client.db
        .select()
        .from(smsUsageLedger)
        .where(eq(smsUsageLedger.outboundMessageId, crossingOutboundId))
    ).resolves.toEqual([]);
    await expect(repository.loadUsage(organisationId)).resolves.toEqual({
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      includedParts: 3,
      warningPercent: 80,
      committedParts: 0,
      reservedParts: 3,
      remainingParts: 0
    });
  });

  it('blocks a retry of a legacy over-limit reservation', async () => {
    const organisationId = await seedPaidOrganisation();
    await client.db.insert(smsAllowanceSettings).values({
      organisationId,
      includedParts: 2,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: 10_000,
      overageCentsPerPart: 1
    });
    await seedPoolNumber({ verified: true, createdAt: new Date(-Date.now()) });
    const number = await repository.reserveAvailableNumber(organisationId, now);
    await repository.markNumberReady(organisationId, number.id, now);
    const outboundMessageId = await seedOutbound(organisationId);
    await client.db.insert(smsUsageLedger).values({
      organisationId,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      outboundMessageId,
      source: 'MANUAL_REMINDER',
      entryType: 'RESERVE',
      partDelta: 3,
      idempotencyKey: `${outboundMessageId}:reserve`,
      occurredAt: now
    });

    await expect(
      repository.reserveUsage({
        organisationId,
        outboundMessageId,
        source: 'MANUAL_REMINDER',
        partCount: 3,
        now
      })
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'SMS_ALLOWANCE_EXHAUSTED',
      projectedParts: 3
    });
    await expect(
      client.db
        .select()
        .from(smsUsageLedger)
        .where(eq(smsUsageLedger.outboundMessageId, outboundMessageId))
    ).resolves.toHaveLength(1);
  });

  it('fails closed when the organisation already has an unverified reservation', async () => {
    const organisationId = await seedPaidOrganisation();
    await seedPoolNumber({ organisationId, status: 'RESERVED' });

    await expect(
      repository.reserveAvailableNumber(organisationId, now)
    ).rejects.toThrow('SMS_NUMBER_NOT_VERIFIED');
  });

  it('does not promote an unverified reserved number', async () => {
    const organisationId = await seedPaidOrganisation();
    const number = await seedPoolNumber({
      organisationId,
      status: 'RESERVED'
    });

    await expect(
      repository.markNumberReady(organisationId, number.id, now)
    ).rejects.toThrow('SMS_NUMBER_NOT_VERIFIED');
  });

  it('preserves same-customer verification during cooling and permits safe reactivation', async () => {
    const organisationId = await seedPaidOrganisation();
    const number = await seedPoolNumber({
      verified: true,
      organisationId,
      status: 'READY'
    });
    await repository.quarantineNumber(
      organisationId,
      new Date('2026-12-10T00:00:00.000Z'),
      now
    );

    await expect(
      client.db.query.smsNumberPool.findFirst({
        where: (table, { eq }) => eq(table.id, number.id)
      })
    ).resolves.toMatchObject({
      status: 'QUARANTINED',
      organisationId,
      providerVerifiedAt: now
    });
    await expect(
      repository.findOrganisationIdByDestinationNumber(number.e164Number)
    ).resolves.toBe(organisationId);
    await expect(
      repository.reserveAvailableNumber(organisationId, now)
    ).resolves.toMatchObject({ id: number.id, status: 'RESERVED' });
    await expect(
      repository.markNumberReady(organisationId, number.id, now)
    ).resolves.toBeUndefined();
  });
});
