import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  organisations,
  retentionCases,
  smsNumberPool,
  subscriptions,
  xeroConnections
} from '@bc5000/db';

import { processSubscriptionLifecycle } from '../src/handlers/subscription-lifecycle.js';
import { placeRetentionLegalHold } from '../src/services/retention-legal-hold.js';
import {
  applySubscriptionCancellationEpisode,
  listCancelledSubscriptionsNeedingLifecycle,
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

const waitForBlockedSubscriptionWrite = async (): Promise<void> => {
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
           and query like '%update "subscriptions"%'
      ) as blocked
    `);
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('reactivation did not wait on the cancellation episode lock');
};

describe('cancelled Solo subscription lifecycle', () => {
  it('leaves replacement subscription resources untouched when reactivation wins before teardown locks', async () => {
    const organisationId = randomUUID();
    const cancelledStripeSubscriptionId = `sub_${organisationId}`;
    const replacementStripeSubscriptionId = `sub_replacement_${organisationId}`;
    const cancelledAt = new Date('2027-04-10T04:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Reactivated cancellation race tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'CANCELLED',
      stripeSubscriptionId: cancelledStripeSubscriptionId,
      cancelledAt
    });
    const [connection] = await client.db
      .insert(xeroConnections)
      .values({
        organisationId,
        connectionId: randomUUID(),
        tenantId: randomUUID(),
        status: 'CONNECTED',
        encryptedRefreshToken: {
          version: 1,
          keyId: 'primary',
          iv: Buffer.alloc(12, 1).toString('base64'),
          ciphertext: Buffer.from('refresh-token').toString('base64'),
          tag: Buffer.alloc(16, 2).toString('base64')
        },
        grantedScopes: ['accounting.transactions']
      })
      .returning();
    const [number] = await client.db
      .insert(smsNumberPool)
      .values({
        e164Number: `+614${Math.floor(Math.random() * 100_000_000)
          .toString()
          .padStart(8, '0')}`,
        provider: 'SINCH',
        providerNumberId: randomUUID(),
        providerVerifiedAt: cancelledAt,
        status: 'READY',
        organisationId,
        reservedAt: cancelledAt,
        readyAt: cancelledAt
      })
      .returning();
    let providerDeletes = 0;

    const result = await applySubscriptionCancellationEpisode(
      client.db,
      {
        organisationId,
        stripeSubscriptionId: cancelledStripeSubscriptionId,
        closureEffectiveAt: cancelledAt,
        disconnectedAt: new Date('2027-04-10T05:00:00.000Z'),
        retentionDeadline: new Date('2027-05-10T05:00:00.000Z'),
        deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z'),
        quarantineUntil: new Date('2027-05-10T05:00:00.000Z')
      },
      {
        prepareXeroDisconnect: async () => {
          await client.db
            .update(subscriptions)
            .set({
              status: 'ACTIVE',
              stripeSubscriptionId: replacementStripeSubscriptionId,
              cancelledAt: null
            })
            .where(eq(subscriptions.organisationId, organisationId));
          return {
            recordId: connection!.id,
            connectionId: connection!.connectionId,
            accessToken: 'replacement-access-token'
          };
        },
        deleteXeroConnection: () => {
          providerDeletes += 1;
          return Promise.resolve();
        }
      }
    );

    expect(result).toBe('STALE');
    expect(providerDeletes).toBe(0);
    expect(
      (
        await client.db
          .select({ status: xeroConnections.status })
          .from(xeroConnections)
          .where(eq(xeroConnections.organisationId, organisationId))
      )[0]?.status
    ).toBe('CONNECTED');
    expect(
      (
        await client.db
          .select({ status: smsNumberPool.status })
          .from(smsNumberPool)
          .where(eq(smsNumberPool.id, number!.id))
      )[0]?.status
    ).toBe('READY');
    expect(
      await client.db
        .select()
        .from(retentionCases)
        .where(eq(retentionCases.organisationId, organisationId))
    ).toHaveLength(0);
  });

  it('makes reactivation wait for an in-flight exact cancellation episode', async () => {
    const organisationId = randomUUID();
    const cancelledStripeSubscriptionId = `sub_${organisationId}`;
    const replacementStripeSubscriptionId = `sub_replacement_${organisationId}`;
    const cancelledAt = new Date('2027-04-10T04:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Cancellation lock ordering tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'CANCELLED',
      stripeSubscriptionId: cancelledStripeSubscriptionId,
      cancelledAt
    });
    const [connection] = await client.db
      .insert(xeroConnections)
      .values({
        organisationId,
        connectionId: randomUUID(),
        tenantId: randomUUID(),
        status: 'CONNECTED',
        encryptedRefreshToken: {
          version: 1,
          keyId: 'primary',
          iv: Buffer.alloc(12, 1).toString('base64'),
          ciphertext: Buffer.from('refresh-token').toString('base64'),
          tag: Buffer.alloc(16, 2).toString('base64')
        },
        grantedScopes: ['accounting.transactions']
      })
      .returning();
    const deleteStarted = deferred<void>();
    const releaseDelete = deferred<void>();

    const cancellation = applySubscriptionCancellationEpisode(
      client.db,
      {
        organisationId,
        stripeSubscriptionId: cancelledStripeSubscriptionId,
        closureEffectiveAt: cancelledAt,
        disconnectedAt: new Date('2027-04-10T05:00:00.000Z'),
        retentionDeadline: new Date('2027-05-10T05:00:00.000Z'),
        deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z'),
        quarantineUntil: new Date('2027-05-10T05:00:00.000Z')
      },
      {
        prepareXeroDisconnect: () =>
          Promise.resolve({
            recordId: connection!.id,
            connectionId: connection!.connectionId,
            accessToken: 'bounded-access-token'
          }),
        deleteXeroConnection: async () => {
          deleteStarted.resolve();
          await releaseDelete.promise;
        }
      }
    );
    await deleteStarted.promise;

    let reactivationCompleted = false;
    const reactivation = client.db
      .update(subscriptions)
      .set({
        status: 'ACTIVE',
        stripeSubscriptionId: replacementStripeSubscriptionId,
        cancelledAt: null
      })
      .where(eq(subscriptions.organisationId, organisationId))
      .then(() => {
        reactivationCompleted = true;
      });
    await waitForBlockedSubscriptionWrite();
    expect(reactivationCompleted).toBe(false);

    releaseDelete.resolve();
    await expect(cancellation).resolves.toBe('APPLIED');
    await reactivation;
    expect(reactivationCompleted).toBe(true);
    await expect(
      loadSubscriptionRetentionState(client.db, organisationId)
    ).resolves.toMatchObject({
      status: 'ACTIVE',
      stripeSubscriptionId: replacementStripeSubscriptionId,
      cancelledAt: null
    });
  }, 10_000);

  it('retries after remote Xero deletion succeeds but the local transaction rolls back', async () => {
    const organisationId = randomUUID();
    const stripeSubscriptionId = `sub_${organisationId}`;
    const cancelledAt = new Date('2027-04-10T04:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Cancellation retry convergence tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'CANCELLED',
      stripeSubscriptionId,
      cancelledAt
    });
    const [connection] = await client.db
      .insert(xeroConnections)
      .values({
        organisationId,
        connectionId: randomUUID(),
        tenantId: randomUUID(),
        status: 'CONNECTED',
        encryptedRefreshToken: {
          version: 1,
          keyId: 'primary',
          iv: Buffer.alloc(12, 1).toString('base64'),
          ciphertext: Buffer.from('refresh-token').toString('base64'),
          tag: Buffer.alloc(16, 2).toString('base64')
        },
        grantedScopes: ['accounting.transactions']
      })
      .returning();
    const [number] = await client.db
      .insert(smsNumberPool)
      .values({
        e164Number: `+614${Math.floor(Math.random() * 100_000_000)
          .toString()
          .padStart(8, '0')}`,
        provider: 'SINCH',
        providerNumberId: randomUUID(),
        providerVerifiedAt: cancelledAt,
        status: 'READY',
        organisationId,
        reservedAt: cancelledAt,
        readyAt: cancelledAt
      })
      .returning();
    const episode = {
      organisationId,
      stripeSubscriptionId,
      closureEffectiveAt: cancelledAt,
      disconnectedAt: new Date('2027-04-10T05:00:00.000Z'),
      retentionDeadline: new Date('2027-05-10T05:00:00.000Z'),
      deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z'),
      quarantineUntil: new Date('2027-05-10T05:00:00.000Z')
    };
    const prepareXeroDisconnect = () =>
      Promise.resolve({
        recordId: connection!.id,
        connectionId: connection!.connectionId,
        accessToken: 'idempotent-access-token'
      });
    let remoteDeleted = false;

    await expect(
      applySubscriptionCancellationEpisode(client.db, episode, {
        prepareXeroDisconnect,
        deleteXeroConnection: () => {
          remoteDeleted = true;
          return Promise.reject(new Error('SIMULATED_LOCAL_FAILURE'));
        }
      })
    ).rejects.toThrow('SIMULATED_LOCAL_FAILURE');
    expect(remoteDeleted).toBe(true);
    expect(
      (
        await client.db
          .select({ status: xeroConnections.status })
          .from(xeroConnections)
          .where(eq(xeroConnections.id, connection!.id))
      )[0]?.status
    ).toBe('CONNECTED');
    expect(
      (
        await client.db
          .select({ status: smsNumberPool.status })
          .from(smsNumberPool)
          .where(eq(smsNumberPool.id, number!.id))
      )[0]?.status
    ).toBe('READY');

    await expect(
      applySubscriptionCancellationEpisode(client.db, episode, {
        prepareXeroDisconnect,
        deleteXeroConnection: () => {
          expect(remoteDeleted).toBe(true);
          return Promise.resolve();
        }
      })
    ).resolves.toBe('APPLIED');
    expect(
      (
        await client.db
          .select({ status: xeroConnections.status })
          .from(xeroConnections)
          .where(eq(xeroConnections.id, connection!.id))
      )[0]?.status
    ).toBe('DISCONNECTED');
    expect(
      (
        await client.db
          .select({ status: smsNumberPool.status })
          .from(smsNumberPool)
          .where(eq(smsNumberPool.id, number!.id))
      )[0]?.status
    ).toBe('QUARANTINED');
    await expect(
      client.db
        .select()
        .from(retentionCases)
        .where(eq(retentionCases.organisationId, organisationId))
    ).resolves.toHaveLength(1);
  });

  it('lists only cancellation episodes without current cleanup evidence', async () => {
    const missingOrganisationId = randomUUID();
    const staleOrganisationId = randomUUID();
    const completeOrganisationId = randomUUID();
    const connectedXeroOrganisationId = randomUUID();
    const readyNumberOrganisationId = randomUUID();
    const activeOrganisationId = randomUUID();
    const cancellationAt = new Date('2027-04-10T04:00:00.000Z');
    const olderCancellationAt = new Date('2026-11-09T12:00:00.000Z');
    await client.db.insert(organisations).values(
      [
        [missingOrganisationId, 'Missing cleanup evidence'],
        [staleOrganisationId, 'Stale cleanup evidence'],
        [completeOrganisationId, 'Complete cleanup evidence'],
        [connectedXeroOrganisationId, 'Reconnected Xero after cancellation'],
        [readyNumberOrganisationId, 'Ready number after cancellation'],
        [activeOrganisationId, 'Active subscription']
      ].map(([id, name]) => ({
        id: id!,
        xeroOrganisationId: randomUUID(),
        name: name!,
        timeZone: 'Australia/Sydney',
        baseCurrency: 'AUD',
        edition: 'SOLO' as const
      }))
    );
    await client.db.insert(subscriptions).values([
      {
        organisationId: missingOrganisationId,
        planCode: 'SOLO_AU_2000',
        status: 'CANCELLED',
        stripeSubscriptionId: `sub_${missingOrganisationId}`,
        cancelledAt: cancellationAt
      },
      {
        organisationId: staleOrganisationId,
        planCode: 'SOLO_AU_2000',
        status: 'CANCELLED',
        stripeSubscriptionId: `sub_${staleOrganisationId}`,
        cancelledAt: cancellationAt
      },
      {
        organisationId: completeOrganisationId,
        planCode: 'SOLO_AU_2000',
        status: 'CANCELLED',
        stripeSubscriptionId: `sub_${completeOrganisationId}`,
        cancelledAt: cancellationAt
      },
      {
        organisationId: connectedXeroOrganisationId,
        planCode: 'SOLO_AU_2000',
        status: 'CANCELLED',
        stripeSubscriptionId: `sub_${connectedXeroOrganisationId}`,
        cancelledAt: cancellationAt
      },
      {
        organisationId: readyNumberOrganisationId,
        planCode: 'SOLO_AU_2000',
        status: 'CANCELLED',
        stripeSubscriptionId: `sub_${readyNumberOrganisationId}`,
        cancelledAt: cancellationAt
      },
      {
        organisationId: activeOrganisationId,
        planCode: 'SOLO_AU_2000',
        status: 'ACTIVE',
        stripeSubscriptionId: `sub_${activeOrganisationId}`,
        cancelledAt: null
      }
    ]);
    await client.db.insert(retentionCases).values([
      {
        organisationId: staleOrganisationId,
        source: 'SUBSCRIPTION_CANCELLED',
        status: 'SCHEDULED',
        disconnectedAt: olderCancellationAt,
        reviewAfter: new Date('2026-12-09T12:00:00.000Z'),
        closureEffectiveAt: olderCancellationAt
      },
      {
        organisationId: completeOrganisationId,
        source: 'SUBSCRIPTION_CANCELLED',
        status: 'SCHEDULED',
        disconnectedAt: cancellationAt,
        reviewAfter: new Date('2027-05-10T04:00:00.000Z'),
        closureEffectiveAt: cancellationAt
      },
      {
        organisationId: connectedXeroOrganisationId,
        source: 'SUBSCRIPTION_CANCELLED',
        status: 'SCHEDULED',
        disconnectedAt: cancellationAt,
        reviewAfter: new Date('2027-05-10T04:00:00.000Z'),
        closureEffectiveAt: cancellationAt
      },
      {
        organisationId: readyNumberOrganisationId,
        source: 'SUBSCRIPTION_CANCELLED',
        status: 'SCHEDULED',
        disconnectedAt: cancellationAt,
        reviewAfter: new Date('2027-05-10T04:00:00.000Z'),
        closureEffectiveAt: cancellationAt
      }
    ]);
    await client.db.insert(xeroConnections).values({
      organisationId: connectedXeroOrganisationId,
      connectionId: randomUUID(),
      tenantId: randomUUID(),
      status: 'CONNECTED',
      encryptedRefreshToken: {
        version: 1,
        keyId: 'primary',
        iv: Buffer.alloc(12, 1).toString('base64'),
        ciphertext: Buffer.from('refresh-token').toString('base64'),
        tag: Buffer.alloc(16, 2).toString('base64')
      },
      grantedScopes: ['accounting.transactions']
    });
    await client.db.insert(smsNumberPool).values({
      e164Number: `+614${Math.floor(Math.random() * 100_000_000)
        .toString()
        .padStart(8, '0')}`,
      provider: 'SINCH',
      providerNumberId: randomUUID(),
      providerVerifiedAt: cancellationAt,
      status: 'READY',
      organisationId: readyNumberOrganisationId,
      reservedAt: olderCancellationAt,
      readyAt: cancellationAt
    });

    const candidates = await listCancelledSubscriptionsNeedingLifecycle(
      client.db
    );

    expect(candidates).toEqual(
      expect.arrayContaining([
        {
          organisationId: missingOrganisationId,
          stripeSubscriptionId: `sub_${missingOrganisationId}`,
          cancelledAt: cancellationAt
        },
        {
          organisationId: staleOrganisationId,
          stripeSubscriptionId: `sub_${staleOrganisationId}`,
          cancelledAt: cancellationAt
        },
        {
          organisationId: connectedXeroOrganisationId,
          stripeSubscriptionId: `sub_${connectedXeroOrganisationId}`,
          cancelledAt: cancellationAt
        },
        {
          organisationId: readyNumberOrganisationId,
          stripeSubscriptionId: `sub_${readyNumberOrganisationId}`,
          cancelledAt: cancellationAt
        }
      ])
    );
    expect(candidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organisationId: completeOrganisationId }),
        expect.objectContaining({ organisationId: activeOrganisationId })
      ])
    );
    await expect(
      loadSubscriptionRetentionState(client.db, completeOrganisationId)
    ).resolves.toMatchObject({ retentionDeadlineRecorded: true });
    await expect(
      loadSubscriptionRetentionState(client.db, connectedXeroOrganisationId)
    ).resolves.toMatchObject({ retentionDeadlineRecorded: false });
    await expect(
      loadSubscriptionRetentionState(client.db, readyNumberOrganisationId)
    ).resolves.toMatchObject({ retentionDeadlineRecorded: false });
  });

  it('disconnects once and persists an auditable retention deadline', async () => {
    const organisationId = randomUUID();
    const firstStripeSubscriptionId = `sub_${organisationId}`;
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
      stripeSubscriptionId: firstStripeSubscriptionId,
      cancelledAt: now
    });
    const disconnects: string[] = [];
    let executionNow = now;

    const dependencies = {
      load: async (candidateOrganisationId: string) => {
        const [subscription] = await client.db
          .select({
            status: subscriptions.status,
            stripeSubscriptionId: subscriptions.stripeSubscriptionId,
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
      applyCancellationEpisode: async (input: {
        organisationId: string;
        stripeSubscriptionId: string;
        disconnectedAt: Date;
        retentionDeadline: Date;
        deletionEligibleAt: Date | null;
        closureEffectiveAt: Date;
      }) => {
        disconnects.push(input.organisationId);
        await recordSubscriptionRetentionDeadline(client.db, input);
        return 'APPLIED' as const;
      },
      clock: { now: () => executionNow }
    };

    await expect(
      processSubscriptionLifecycle(dependencies, {
        organisationId,
        status: 'CANCELLED',
        stripeSubscriptionId: firstStripeSubscriptionId,
        cancelledAt: now.toISOString()
      })
    ).resolves.toBe('DISCONNECTED');
    await expect(
      processSubscriptionLifecycle(dependencies, {
        organisationId,
        status: 'CANCELLED',
        stripeSubscriptionId: firstStripeSubscriptionId,
        cancelledAt: now.toISOString()
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
    const newerStripeSubscriptionId = `sub_newer_${organisationId}`;
    executionNow = new Date('2027-04-11T00:00:00.000Z');
    await client.db
      .update(subscriptions)
      .set({
        stripeSubscriptionId: newerStripeSubscriptionId,
        cancelledAt: newerCancellation
      })
      .where(eq(subscriptions.organisationId, organisationId));

    await expect(
      processSubscriptionLifecycle(dependencies, {
        organisationId,
        status: 'CANCELLED',
        stripeSubscriptionId: newerStripeSubscriptionId,
        cancelledAt: newerCancellation.toISOString()
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
    const stripeSubscriptionId = `sub_${organisationId}`;
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
      stripeSubscriptionId,
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
        applyCancellationEpisode: async (input) => {
          disconnects.push(input.organisationId);
          quarantines.push(input.organisationId);
          await recordSubscriptionRetentionDeadline(client.db, input);
          return 'APPLIED';
        },
        clock: { now: () => new Date('2027-04-11T01:00:00.000Z') }
      },
      {
        organisationId,
        status: 'CANCELLED',
        stripeSubscriptionId,
        cancelledAt: cancellationAt.toISOString()
      }
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
