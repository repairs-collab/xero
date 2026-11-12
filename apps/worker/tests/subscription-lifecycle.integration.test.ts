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
import { recordSubscriptionRetentionDeadline } from '../src/services/subscription-retention.js';

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
    let executionNow = now;

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
          .select({
            organisationId: retentionCases.organisationId,
            closureEffectiveAt: retentionCases.closureEffectiveAt
          })
          .from(retentionCases)
          .where(eq(retentionCases.organisationId, candidateOrganisationId));
        return {
          ...subscription,
          retentionDeadlineRecorded: recorded !== undefined,
          recordedCancellationAt: recorded?.closureEffectiveAt ?? null
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
        closureEffectiveAt: Date;
      }) => {
        await recordSubscriptionRetentionDeadline(client.db, input);
      },
      clock: { now: () => executionNow }
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
    expect(audit?.afterValue).toMatchObject({
      closureVersion: 1,
      closureEffectiveAt: '2026-11-09T12:00:00.000Z',
      disconnectedAt: '2026-11-09T12:00:00.000Z',
      retentionDeadline: '2026-12-09T12:00:00.000Z',
      deletionEligibleAt: '2031-11-09T12:00:00.000Z',
      staleBackupEvidenceCleared: false
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
      closureVersion: 1,
      closureEffectiveAt: now,
      reviewAfter: new Date('2026-12-09T12:00:00.000Z'),
      deletionEligibleAt: new Date('2031-11-09T12:00:00.000Z')
    });

    const firstCase = (
      await client.db
        .select()
        .from(retentionCases)
        .where(eq(retentionCases.organisationId, organisationId))
    )[0]!;
    await client.db
      .update(retentionCases)
      .set({
        backupExpiryVerifiedAt: new Date('2031-11-10T00:00:00.000Z'),
        backupExpiryEvidenceReference: 'old-episode-backup-evidence',
        backupExpiryClosureEpisodeId: firstCase.closureEpisodeId
      })
      .where(eq(retentionCases.organisationId, organisationId));
    const newerCancellation = new Date('2027-04-10T04:00:00.000Z');
    executionNow = new Date('2027-04-11T00:00:00.000Z');
    await client.db
      .update(subscriptions)
      .set({ cancelledAt: newerCancellation })
      .where(eq(subscriptions.organisationId, organisationId));

    await expect(
      processSubscriptionLifecycle(dependencies, {
        organisationId,
        status: 'CANCELLED'
      })
    ).resolves.toBe('DISCONNECTED');

    const [renewedCase] = await client.db
      .select()
      .from(retentionCases)
      .where(eq(retentionCases.organisationId, organisationId));
    expect(disconnects).toEqual([organisationId, organisationId]);
    expect(renewedCase).toMatchObject({
      closureVersion: 2,
      closureEffectiveAt: newerCancellation,
      deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z'),
      backupExpiryVerifiedAt: null,
      backupExpiryEvidenceReference: null,
      backupExpiryClosureEpisodeId: null
    });
    expect(renewedCase?.closureEpisodeId).not.toBe(firstCase.closureEpisodeId);
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, organisationId),
            eq(auditEvents.eventType, 'SUBSCRIPTION_RETENTION_SCHEDULED')
          )
        )
    ).toHaveLength(2);
  });
});
