import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { organisations, subscriptions, users } from '../schema/index.js';
import { PostgresPlatformAdminRepository } from './platform-admin-repository.js';
import { PostgresReplyNumberProvisioningRepository } from './reply-number-provisioning-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const provisioning = new PostgresReplyNumberProvisioningRepository(client.db);
const platform = new PostgresPlatformAdminRepository(client.db);
const ownerId = randomUUID();
const now = new Date('2026-11-12T02:30:00.000Z');

beforeAll(async () => {
  await migrateDatabase(client.db);
  await client.db.insert(users).values({
    id: ownerId,
    cognitoSubject: `number-reassignment-owner-${ownerId}`,
    email: `number-reassignment-owner-${ownerId}@example.test`,
    displayName: 'Number reassignment owner',
    platformRole: 'OWNER'
  });
});
afterAll(() => client.pool.end());

const seedPaidOrganisation = async () => {
  const organisationId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: `number-reassignment-${organisationId}`,
    name: `Number reassignment ${organisationId}`,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO',
    platformStatus: 'ACTIVE'
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: 'ACTIVE',
    trustedStripeProviderStatus: 'active',
    currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-12-12T00:00:00.000Z')
  });
  return organisationId;
};

describe('fulfilled reply number reassignment lifecycle', () => {
  it('does not assign a legacy pool number while manual provisioning is active', async () => {
    const organisationId = await seedPaidOrganisation();
    const request = await provisioning.ensureRequestForPaidOrganisation({
      organisationId,
      provider: 'SINCH',
      now
    });
    if (!request.ok) throw new Error(`request failed: ${request.code}`);
    const registered = await platform.registerSmsNumber({
      actorUserId: ownerId,
      e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
      provider: 'SINCH',
      providerNumberId: null,
      reason: 'Legacy assignment interleaving regression',
      now
    });
    if (!registered.ok) throw new Error(`registration failed: ${registered.code}`);

    await expect(
      platform.assignSmsNumber({
        actorUserId: ownerId,
        numberId: registered.value.id,
        organisationId,
        expectedStatus: 'AVAILABLE',
        expectedUpdatedAt: registered.value.updatedAt,
        reason: 'Must not bypass manual provisioning',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'INVALID_STATE' });
    await expect(
      client.db.query.smsNumberPool.findFirst({
        where: (table, { eq }) => eq(table.id, registered.value.id)
      })
    ).resolves.toMatchObject({ status: 'AVAILABLE', organisationId: null });
  });

  it('serializes concurrent manual-request and legacy-assignment creation', async () => {
    const organisationId = await seedPaidOrganisation();
    const registered = await platform.registerSmsNumber({
      actorUserId: ownerId,
      e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
      provider: 'SINCH',
      providerNumberId: null,
      reason: 'Concurrent interleaving regression',
      now
    });
    if (!registered.ok) throw new Error(`registration failed: ${registered.code}`);

    const [requestResult, assignmentResult] = await Promise.all([
      provisioning.ensureRequestForPaidOrganisation({
        organisationId,
        provider: 'SINCH',
        now
      }),
      platform.assignSmsNumber({
        actorUserId: ownerId,
        numberId: registered.value.id,
        organisationId,
        expectedStatus: 'AVAILABLE',
        expectedUpdatedAt: registered.value.updatedAt,
        reason: 'Competing legacy assignment',
        now
      })
    ]);

    expect([requestResult.ok, assignmentResult.ok].filter(Boolean)).toHaveLength(1);
    const requests = await client.db.query.replyNumberProvisioningRequests.findMany({
      where: (table, { eq }) => eq(table.organisationId, organisationId)
    });
    const number = await client.db.query.smsNumberPool.findFirst({
      where: (table, { eq }) => eq(table.id, registered.value.id)
    });
    expect([
      requests.length === 1,
      number?.organisationId === organisationId
    ].filter(Boolean)).toHaveLength(1);
  });

  it('returns a fulfilled number to the pool and reassigns it after quarantine', async () => {
    const originalOrganisationId = await seedPaidOrganisation();
    const nextOrganisationId = await seedPaidOrganisation();
    const requested = await provisioning.ensureRequestForPaidOrganisation({
      organisationId: originalOrganisationId,
      provider: 'SINCH',
      now
    });
    if (!requested.ok) throw new Error(`request failed: ${requested.code}`);
    const quoted = await provisioning.recordQuote({
      actorUserId: ownerId,
      organisationId: originalOrganisationId,
      requestId: requested.value.id,
      expectedVersion: requested.value.version,
      setupFeeMinor: 1_135,
      monthlyFeeMinor: 1_530,
      currency: 'aud',
      quoteExpiresAt: new Date('2026-11-20T00:00:00.000Z'),
      documentationStatus: 'NOT_REQUIRED',
      documentationEvidenceReference: null,
      reason: 'Quoted for lifecycle regression',
      now
    });
    if (!quoted.ok) throw new Error(`quote failed: ${quoted.code}`);
    const approved = await provisioning.approveManualOrder({
      actorUserId: ownerId,
      organisationId: originalOrganisationId,
      requestId: quoted.value.id,
      expectedVersion: quoted.value.version,
      confirmedSetupFeeMinor: 1_135,
      confirmedMonthlyFeeMinor: 1_530,
      reason: 'Approved for lifecycle regression',
      now
    });
    if (!approved.ok) throw new Error(`approval failed: ${approved.code}`);
    const ordered = await provisioning.recordManualOrderReference({
      actorUserId: ownerId,
      organisationId: originalOrganisationId,
      requestId: approved.value.id,
      expectedVersion: approved.value.version,
      externalOrderReference: `ORDER-${randomUUID()}`,
      reason: 'Recorded for lifecycle regression',
      now
    });
    if (!ordered.ok) throw new Error(`order failed: ${ordered.code}`);
    const fulfilled = await provisioning.recordFulfilledNumber({
      actorUserId: ownerId,
      organisationId: originalOrganisationId,
      requestId: ordered.value.id,
      expectedVersion: ordered.value.version,
      e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
      providerNumberId: `sinch-${randomUUID()}`,
      reason: 'Fulfilled for lifecycle regression',
      now
    });
    if (!fulfilled.ok || !fulfilled.value.fulfilledNumberId) {
      throw new Error('fulfilment failed');
    }
    const number = await client.db.query.smsNumberPool.findFirst({
      where: (table, { eq }) =>
        eq(table.id, fulfilled.value.fulfilledNumberId!)
    });
    if (!number) throw new Error('number missing');

    const released = await platform.releaseSmsNumber({
      actorUserId: ownerId,
      numberId: number.id,
      expectedStatus: 'RESERVED',
      expectedUpdatedAt: number.updatedAt,
      reason: 'Original customer disconnected',
      now
    });
    if (!released.ok) throw new Error(`release failed: ${released.code}`);
    const returnTime = new Date('2026-12-12T02:30:00.000Z');
    const returned = await platform.returnSmsNumberToPool({
      actorUserId: ownerId,
      numberId: number.id,
      expectedStatus: 'QUARANTINED',
      expectedUpdatedAt: released.value.updatedAt,
      reason: 'Quarantine completed',
      now: returnTime
    });

    expect(returned).toMatchObject({
      ok: true,
      value: { status: 'AVAILABLE', organisationId: null }
    });
    if (!returned.ok) throw new Error(`return failed: ${returned.code}`);
    await expect(
      platform.assignSmsNumber({
        actorUserId: ownerId,
        numberId: number.id,
        organisationId: nextOrganisationId,
        expectedStatus: 'AVAILABLE',
        expectedUpdatedAt: returned.value.updatedAt,
        reason: 'Assign after completed quarantine',
        now: returnTime
      })
    ).resolves.toMatchObject({
      ok: true,
      value: {
        id: number.id,
        status: 'RESERVED',
        organisationId: nextOrganisationId
      }
    });
  });
});
