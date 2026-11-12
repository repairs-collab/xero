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
import { placeRetentionLegalHold } from '../src/services/retention-legal-hold.js';
import {
  loadSubscriptionRetentionState,
  recordSubscriptionRetentionDeadline
} from '../src/services/subscription-retention.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-09T12:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

const waitForBlockedRetentionWrite = async (): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.pool.query<{ blocked: boolean }>(`
      select exists (
        select 1
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and state = 'active'
           and wait_event_type = 'Lock'
           and query like '%"retention_cases"%'
      ) as blocked
    `);
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('cancellation did not reach the controlled retention lock');
};

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

  it('preserves a legal hold committed while a newer cancellation is being recorded', async () => {
    const organisationId = randomUUID();
    const firstClosure = new Date('2026-11-09T12:00:00.000Z');
    const secondClosure = new Date('2027-04-10T04:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Concurrent cancellation hold tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO'
    });
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'SCHEDULED',
      disconnectedAt: firstClosure,
      reviewAfter: new Date('2026-12-09T12:00:00.000Z'),
      closureEffectiveAt: firstClosure,
      deletionEligibleAt: new Date('2031-11-09T12:00:00.000Z')
    });

    const writerReady = deferred<void>();
    const releaseWriter = deferred<void>();
    const legalHoldWriter = client.db.transaction(async (transaction) => {
      await transaction
        .select({ organisationId: retentionCases.organisationId })
        .from(retentionCases)
        .where(eq(retentionCases.organisationId, organisationId))
        .for('update');
      await transaction
        .update(retentionCases)
        .set({ status: 'LEGAL_HOLD' })
        .where(eq(retentionCases.organisationId, organisationId));
      writerReady.resolve();
      await releaseWriter.promise;
    });
    await writerReady.promise;

    const cancellation = recordSubscriptionRetentionDeadline(client.db, {
      organisationId,
      disconnectedAt: new Date('2027-04-11T00:00:00.000Z'),
      retentionDeadline: new Date('2027-05-11T00:00:00.000Z'),
      deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z'),
      closureEffectiveAt: secondClosure
    });
    await waitForBlockedRetentionWrite();
    releaseWriter.resolve();
    await legalHoldWriter;

    await expect(cancellation).resolves.toBe('RECORDED');
    expect(
      (
        await client.db
          .select()
          .from(retentionCases)
          .where(eq(retentionCases.organisationId, organisationId))
      )[0]
    ).toMatchObject({
      status: 'LEGAL_HOLD',
      closureVersion: 2,
      closureEffectiveAt: secondClosure
    });
  }, 10_000);

  it('runs the production cancellation lifecycle when an initial legal hold is unbound', async () => {
    const organisationId = randomUUID();
    const cancellationAt = new Date('2027-04-10T04:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Pre-lifecycle legal hold tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'CANCELLED',
      cancelledAt: cancellationAt
    });
    await placeRetentionLegalHold(client.db, {
      organisationId,
      recordedAt: new Date('2027-04-11T00:00:00.000Z'),
      reason: 'Preserve records while the cancellation lifecycle is pending'
    });

    const disconnects: string[] = [];
    const quarantines: string[] = [];
    const result = await processSubscriptionLifecycle(
      {
        load: (candidateOrganisationId: string) =>
          loadSubscriptionRetentionState(
            client.db,
            candidateOrganisationId
          ),
        disconnectXero: (candidateOrganisationId: string) => {
          disconnects.push(candidateOrganisationId);
          return Promise.resolve();
        },
        quarantineSmsNumber: (candidateOrganisationId: string) => {
          quarantines.push(candidateOrganisationId);
          return Promise.resolve();
        },
        recordRetentionDeadline: (input) =>
          recordSubscriptionRetentionDeadline(client.db, input).then(
            () => undefined
          ),
        clock: { now: () => new Date('2027-04-11T01:00:00.000Z') }
      },
      { organisationId, status: 'CANCELLED' }
    );

    expect(result).toBe('DISCONNECTED');
    expect(disconnects).toEqual([organisationId]);
    expect(quarantines).toEqual([organisationId]);
    expect(
      (
        await client.db
          .select()
          .from(retentionCases)
          .where(eq(retentionCases.organisationId, organisationId))
      )[0]
    ).toMatchObject({
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'LEGAL_HOLD',
      closureVersion: 2,
      closureEffectiveAt: cancellationAt,
      deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z')
    });
  });
});
