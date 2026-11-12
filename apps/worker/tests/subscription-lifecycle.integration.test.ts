import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  organisations,
  retentionCases,
  subscriptions
} from '@bc5000/db';

import { processSubscriptionLifecycle } from '../src/handlers/subscription-lifecycle.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-09T12:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('cancelled Solo subscription lifecycle', () => {
  it('disconnects once and persists an auditable retention deadline', async () => {
    const organisationId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Cancelled Solo organisation',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'CANCELLED',
      cancelledAt: now
    });
    const disconnects: string[] = [];

    const dependencies = {
      load: async (candidateOrganisationId: string) => {
        const [subscription] = await client.db
          .select({
            status: subscriptions.status,
            cancelledAt: subscriptions.cancelledAt
          })
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, candidateOrganisationId));
        if (subscription === undefined) return null;
        const [recorded] = await client.db
          .select({ organisationId: retentionCases.organisationId })
          .from(retentionCases)
          .where(eq(retentionCases.organisationId, candidateOrganisationId));
        return {
          ...subscription,
          retentionDeadlineRecorded: recorded !== undefined
        };
      },
      disconnectXero: (candidateOrganisationId: string) => {
        disconnects.push(candidateOrganisationId);
        return Promise.resolve();
      },
      quarantineSmsNumber: () => Promise.resolve(),
      recordRetentionDeadline: async (input: {
        organisationId: string;
        disconnectedAt: Date;
        retentionDeadline: Date;
        deletionEligibleAt: Date | null;
      }) => {
        await client.db.transaction(async (transaction) => {
          await transaction.insert(retentionCases).values({
            organisationId: input.organisationId,
            source: 'SUBSCRIPTION_CANCELLED',
            disconnectedAt: input.disconnectedAt,
            reviewAfter: input.retentionDeadline,
            deletionEligibleAt: input.deletionEligibleAt
          });
          await transaction.insert(auditEvents).values({
            organisationId: input.organisationId,
            eventType: 'SUBSCRIPTION_RETENTION_SCHEDULED',
            entityType: 'SUBSCRIPTION',
            entityId: input.organisationId,
            afterValue: {
              disconnectedAt: input.disconnectedAt.toISOString(),
              retentionDeadline: input.retentionDeadline.toISOString(),
              deletionEligibleAt: input.deletionEligibleAt?.toISOString() ?? null
            },
            occurredAt: input.disconnectedAt
          });
        });
      },
      clock: { now: () => now }
    };

    await expect(
      processSubscriptionLifecycle(dependencies, {
        organisationId,
        status: 'CANCELLED'
      })
    ).resolves.toBe('DISCONNECTED');
    await expect(
      processSubscriptionLifecycle(dependencies, {
        organisationId,
        status: 'CANCELLED'
      })
    ).resolves.toBe('ALREADY_APPLIED');

    expect(disconnects).toEqual([organisationId]);
    const [audit] = await client.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, organisationId),
          eq(auditEvents.eventType, 'SUBSCRIPTION_RETENTION_SCHEDULED')
        )
      );
    expect(audit?.afterValue).toEqual({
      disconnectedAt: '2026-11-09T12:00:00.000Z',
      retentionDeadline: '2026-12-09T12:00:00.000Z',
      deletionEligibleAt: '2031-11-09T12:00:00.000Z'
    });
    expect(
      (
        await client.db
          .select()
          .from(retentionCases)
          .where(eq(retentionCases.organisationId, organisationId))
      )[0]
    ).toMatchObject({
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'SCHEDULED',
      reviewAfter: new Date('2026-12-09T12:00:00.000Z'),
      deletionEligibleAt: new Date('2031-11-09T12:00:00.000Z')
    });
  });
});
