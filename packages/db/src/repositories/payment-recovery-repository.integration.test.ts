import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { auditEvents, billingCases, organisations } from '../schema/index.js';
import { PostgresPaymentRecoveryRepository } from './payment-recovery-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const recoverySuiteLockKey = 791_827_463;
let recoverySuiteLock: {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(): void;
} | null = null;

beforeAll(async () => {
  recoverySuiteLock = await client.pool.connect();
  await recoverySuiteLock.query('select pg_advisory_lock($1)', [
    recoverySuiteLockKey
  ]);
  await migrateDatabase(client.db);
}, 120_000);
afterAll(async () => {
  if (recoverySuiteLock !== null) {
    await recoverySuiteLock.query('select pg_advisory_unlock($1)', [
      recoverySuiteLockKey
    ]);
    recoverySuiteLock.release();
  }
  await client.pool.end();
}, 120_000);

describe('PostgresPaymentRecoveryRepository', () => {
  it('moves only a bounded batch of due current payment failures into owner review', async () => {
    const organisationId = randomUUID();
    const now = new Date('1000-01-12T00:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Recovery review test',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO'
    });

    const cases = [
      {
        id: randomUUID(),
        providerObjectId: `in_${randomUUID()}`,
        status: 'OPEN' as const,
        subscriptionRelation: 'CURRENT' as const,
        blocksSending: true,
        recoveryEndsAt: new Date('1000-01-10T00:00:00.000Z'),
        resolvedAt: null
      },
      {
        id: randomUUID(),
        providerObjectId: `in_${randomUUID()}`,
        status: 'OPEN' as const,
        subscriptionRelation: 'CURRENT' as const,
        blocksSending: true,
        recoveryEndsAt: new Date('1000-01-11T00:00:00.000Z'),
        resolvedAt: null
      },
      {
        id: randomUUID(),
        providerObjectId: `in_${randomUUID()}`,
        status: 'OPEN' as const,
        subscriptionRelation: 'CURRENT' as const,
        blocksSending: true,
        recoveryEndsAt: new Date('1000-01-13T00:00:00.000Z'),
        resolvedAt: null
      },
      {
        id: randomUUID(),
        providerObjectId: `in_${randomUUID()}`,
        status: 'RESOLVED' as const,
        subscriptionRelation: 'CURRENT' as const,
        blocksSending: false,
        recoveryEndsAt: new Date('1000-01-09T00:00:00.000Z'),
        resolvedAt: new Date('1000-01-09T01:00:00.000Z')
      },
      {
        id: randomUUID(),
        providerObjectId: `in_${randomUUID()}`,
        status: 'OPEN' as const,
        subscriptionRelation: 'RETIRED' as const,
        blocksSending: false,
        recoveryEndsAt: new Date('1000-01-08T00:00:00.000Z'),
        resolvedAt: null
      }
    ];
    await client.db.insert(billingCases).values(
      cases.map((item) => ({
        ...item,
        organisationId,
        kind: 'PAYMENT_FAILURE' as const,
        providerObjectType: 'INVOICE' as const,
        providerStatus: 'open',
        stripeSubscriptionId: `sub_${randomUUID()}`,
        amountMinor: 12_345,
        currency: 'aud',
        latestProviderEventId: `evt_${randomUUID()}`,
        latestProviderEventCreatedAt: new Date('0999-12-12T00:00:00.000Z'),
        openedAt: new Date('0999-12-12T00:00:00.000Z')
      }))
    );

    const repository = new PostgresPaymentRecoveryRepository(client.db);
    await expect(
      repository.markDueForReview({ now, limit: 1 })
    ).resolves.toBe(1);
    await expect(
      repository.markDueForReview({ now, limit: 1 })
    ).resolves.toBe(1);
    await expect(
      repository.markDueForReview({ now, limit: 1 })
    ).resolves.toBe(0);

    const rows = await client.db
      .select({ id: billingCases.id, status: billingCases.status })
      .from(billingCases)
      .where(
        inArray(
          billingCases.id,
          cases.map((item) => item.id)
        )
      );
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [cases[0]!.id, 'REVIEW_REQUIRED'],
        [cases[1]!.id, 'REVIEW_REQUIRED'],
        [cases[2]!.id, 'OPEN'],
        [cases[3]!.id, 'RESOLVED'],
        [cases[4]!.id, 'OPEN']
      ])
    );

    const events = await client.db
      .select({ entityId: auditEvents.entityId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, organisationId),
          eq(auditEvents.eventType, 'PAYMENT_RECOVERY_REVIEW_REQUIRED'),
          inArray(auditEvents.entityId, [cases[0]!.id, cases[1]!.id])
        )
      );
    expect(new Set(events.map((event) => event.entityId))).toEqual(
      new Set([cases[0]!.id, cases[1]!.id])
    );
  });

  it('claims due cases once across concurrent workers and keeps audit evidence tenant-scoped', async () => {
    const organisationIds = [randomUUID(), randomUUID()];
    await client.db.insert(organisations).values(
      organisationIds.map((id, index) => ({
        id,
        xeroOrganisationId: randomUUID(),
        name: `Concurrent recovery tenant ${index + 1}`,
        timeZone: 'Australia/Sydney',
        baseCurrency: 'AUD',
        edition: 'SOLO' as const
      }))
    );
    const caseIds = [randomUUID(), randomUUID()];
    await client.db.insert(billingCases).values(
      caseIds.map((id, index) => ({
        id,
        organisationId: organisationIds[index]!,
        kind: 'PAYMENT_FAILURE' as const,
        status: 'OPEN' as const,
        providerObjectType: 'INVOICE' as const,
        providerObjectId: `in_${randomUUID()}`,
        providerStatus: 'open',
        stripeSubscriptionId: `sub_${randomUUID()}`,
        subscriptionRelation: 'CURRENT' as const,
        amountMinor: 10_000,
        currency: 'aud',
        blocksSending: true,
        latestProviderEventId: `evt_${randomUUID()}`,
        latestProviderEventCreatedAt: new Date('0899-12-01T00:00:00.000Z'),
        openedAt: new Date('0899-12-01T00:00:00.000Z'),
        recoveryEndsAt: new Date('0899-12-31T00:00:00.000Z')
      }))
    );

    const first = new PostgresPaymentRecoveryRepository(client.db);
    const second = new PostgresPaymentRecoveryRepository(client.db);
    const counts = await Promise.all([
      first.markDueForReview({
        now: new Date('0900-01-01T00:00:00.000Z'),
        limit: 100
      }),
      second.markDueForReview({
        now: new Date('0900-01-01T00:00:00.000Z'),
        limit: 100
      })
    ]);
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(2);

    const transitioned = await client.db
      .select({ id: billingCases.id, status: billingCases.status })
      .from(billingCases)
      .where(inArray(billingCases.id, caseIds));
    expect(
      new Map(transitioned.map((row) => [row.id, row.status]))
    ).toEqual(
      new Map(caseIds.map((id) => [id, 'REVIEW_REQUIRED']))
    );

    const events = await client.db
      .select({
        organisationId: auditEvents.organisationId,
        entityId: auditEvents.entityId
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, 'PAYMENT_RECOVERY_REVIEW_REQUIRED'),
          inArray(auditEvents.entityId, caseIds)
        )
      );
    expect(
      new Set(events.map((event) => `${event.organisationId}:${event.entityId}`))
    ).toEqual(
      new Set(
        caseIds.map((id, index) => `${organisationIds[index]}:${id}`)
      )
    );
  });
});
