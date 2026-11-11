import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  organisationOnboarding,
  organisations,
  outboundMessages,
  smsNumberPool,
  subscriptions
} from '../schema/index.js';
import { PostgresSmsCommerceRepository } from './sms-commerce-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const repository = new PostgresSmsCommerceRepository(client.db);
const periodStart = new Date('2026-11-01T00:00:00.000Z');
const periodEnd = new Date('2026-12-01T00:00:00.000Z');
const now = new Date('2026-11-10T00:00:00.000Z');

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

const seedPaidOrganisation = async () => {
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
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd
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
