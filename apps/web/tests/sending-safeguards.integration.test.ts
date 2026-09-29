import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  approvals,
  auditEvents,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  operationalResetRuns,
  organisations,
  outboundMessages,
  providerConnections,
  reminderSequences,
  reminderSequenceVersions,
  rolloutReconciliations,
  stageInstances,
  users
} from '@bc5000/db';

import {
  createSendingSettings,
  CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
  getCustomerRolloutReadiness,
  liveActivationFeedback,
  LIVE_ACKNOWLEDGEMENT,
  RECONCILIATION_ACKNOWLEDGEMENT
} from '../src/app/(protected)/settings/sending/sending-settings.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-18T02:00:00.000Z');
const syncCompletedAt = new Date(now.getTime() - 5 * 60_000);
const controlledNumber = '+61400000001';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedBasic() {
  const organisationId = randomUUID();
  const userId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Sending test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    lastSuccessfulSyncAt: syncCompletedAt
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Admin'
  });
  const session = (role: 'ADMIN' | 'OPERATOR'): AppSession => ({
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'User',
    expiresAt: '2026-09-18T10:00:00Z',
    memberships: [{ organisationId, role, active: true }]
  });
  return { organisationId, userId, session };
}

async function seedCustomerRolloutReady() {
  const seeded = await seedBasic();
  await client.db
    .update(organisations)
    .set({
      sendMode: 'live',
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: true,
      recipientAllowlist: [controlledNumber],
      operationalState: 'RECONCILIATION_REQUIRED',
      operationalStateVersion: 3
    })
    .where(eq(organisations.id, seeded.organisationId));

  await client.db.insert(providerConnections).values([
    {
      organisationId: seeded.organisationId,
      provider: 'XERO',
      secretArn: 'arn:aws:secretsmanager:ap-southeast-2:123:secret:xero',
      enabled: true,
      connectedAt: new Date(now.getTime() - 60 * 60_000),
      lastSuccessfulAuthenticationAt: new Date(now.getTime() - 60 * 60_000)
    },
    {
      organisationId: seeded.organisationId,
      provider: 'SINCH',
      secretArn: 'arn:aws:secretsmanager:ap-southeast-2:123:secret:sinch',
      enabled: true,
      connectedAt: new Date(now.getTime() - 60 * 60_000),
      lastSuccessfulAuthenticationAt: new Date(now.getTime() - 60 * 60_000)
    }
  ]);

  const contactId = randomUUID();
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId: seeded.organisationId,
    xeroContactId: randomUUID(),
    name: 'Reconciliation customer',
    active: true
  });
  const audInvoiceId = randomUUID();
  await client.db.insert(invoices).values([
    {
      id: audInvoiceId,
      organisationId: seeded.organisationId,
      xeroInvoiceId: randomUUID(),
      contactId,
      invoiceNumber: `AUD-${randomUUID()}`,
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '150.2500',
      currency: 'AUD',
      syncVersion: 1
    },
    {
      organisationId: seeded.organisationId,
      xeroInvoiceId: randomUUID(),
      contactId,
      invoiceNumber: `USD-${randomUUID()}`,
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '42.5000',
      currency: 'USD',
      syncVersion: 1
    }
  ]);

  const sequenceId = randomUUID();
  await client.db.insert(reminderSequences).values([
    {
      id: sequenceId,
      organisationId: seeded.organisationId,
      name: `Review sequence ${randomUUID()}`,
      mode: 'REVIEW',
      enabled: true
    },
    {
      organisationId: seeded.organisationId,
      name: `Disabled automatic ${randomUUID()}`,
      mode: 'AUTOMATIC',
      enabled: false
    }
  ]);
  const [version] = await client.db
    .insert(reminderSequenceVersions)
    .values({
      organisationId: seeded.organisationId,
      sequenceId,
      versionNumber: 1,
      status: 'ACTIVE'
    })
    .returning({ id: reminderSequenceVersions.id });
  if (!version) throw new Error('TEST_SEQUENCE_VERSION_NOT_CREATED');
  const [chase] = await client.db
    .insert(invoiceChases)
    .values({
      organisationId: seeded.organisationId,
      invoiceId: audInvoiceId,
      sequenceId,
      customerId: contactId,
      status: 'ACTIVE'
    })
    .returning({ id: invoiceChases.id });
  if (!chase) throw new Error('TEST_CHASE_NOT_CREATED');
  const [stage] = await client.db
    .insert(stageInstances)
    .values({
      organisationId: seeded.organisationId,
      invoiceChaseId: chase.id,
      sequenceVersionId: version.id,
      stageKey: 'due',
      channel: 'SMS',
      status: 'PENDING_APPROVAL',
      scheduledAt: now,
      sourceVersion: 1
    })
    .returning({ id: stageInstances.id });
  if (!stage) throw new Error('TEST_STAGE_NOT_CREATED');
  await client.db.insert(approvals).values({
    organisationId: seeded.organisationId,
    stageInstanceId: stage.id,
    renderedPreview: 'Not exposed in readiness or audit output',
    sourceVersion: 1,
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + 60 * 60_000)
  });
  const [controlledSms] = await client.db
    .insert(outboundMessages)
    .values({
      organisationId: seeded.organisationId,
      actorUserId: seeded.userId,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: controlledNumber,
      content: 'Private test content',
      status: 'ACCEPTED',
      idempotencyKey: randomUUID(),
      completedAt: new Date(now.getTime() - 2 * 60 * 60_000),
      createdAt: new Date(now.getTime() - 2 * 60 * 60_000),
      updatedAt: new Date(now.getTime() - 2 * 60 * 60_000)
    })
    .returning({ id: outboundMessages.id });
  if (!controlledSms) throw new Error('TEST_SMS_NOT_CREATED');

  return { ...seeded, contactId, sequenceId, controlledSmsId: controlledSms.id };
}

async function reconcile(
  seeded: Awaited<ReturnType<typeof seedCustomerRolloutReady>>
) {
  const service = createSendingSettings({
    database: client.db,
    clock: { now: () => now }
  });
  const readiness = await getCustomerRolloutReadiness(client.db, {
    organisationId: seeded.organisationId,
    now
  });
  await service.acknowledgeReconciliation(seeded.session('ADMIN'), {
    organisationId: seeded.organisationId,
    acknowledgement: RECONCILIATION_ACKNOWLEDGEMENT,
    expectedVersion: 3,
    expected: {
      syncCompletedAt: syncCompletedAt.toISOString(),
      metrics: readiness.metrics
    }
  });
  return service;
}

describe('global sending safeguards', () => {
  it('explains controlled-live refusals without exposing internal errors', () => {
    expect(liveActivationFeedback('PROVIDERS_UNHEALTHY')).toMatchObject({
      tone: 'error',
      title: 'Provider checks are out of date'
    });
    expect(liveActivationFeedback('XERO_SYNC_STALE')).toMatchObject({
      tone: 'error',
      title: 'Xero data is not fresh enough'
    });
    expect(liveActivationFeedback('ALLOWLIST_REQUIRED')).toMatchObject({
      tone: 'error',
      title: 'Add a controlled recipient first'
    });
    expect(liveActivationFeedback('enabled')).toMatchObject({
      tone: 'success',
      title: 'Controlled live mode enabled'
    });
    expect(liveActivationFeedback('database-password')).toMatchObject({
      tone: 'error',
      title: 'Live sending was not enabled'
    });
  });

  it('normalises controlled recipients while keeping dry-run as the default', async () => {
    const seeded = await seedBasic();
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => now }
    });
    await service.updateAllowlist(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      recipients: [
        '0400 000 001',
        '+61 400 000 001',
        ' Accounts@Example.COM ',
        'accounts@example.com'
      ]
    });
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'dry-run',
      recipientAllowlist: [controlledNumber, 'accounts@example.com']
    });
  });

  it('permits only an Admin to enter controlled live after current provider checks', async () => {
    const seeded = await seedBasic();
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => now }
    });
    await expect(
      service.activateLive(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        acknowledgement: LIVE_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      service.activateLive(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: LIVE_ACKNOWLEDGEMENT
      })
    ).rejects.toThrow('PROVIDERS_UNHEALTHY');
    await client.db.insert(providerConnections).values([
      {
        organisationId: seeded.organisationId,
        provider: 'XERO',
        secretArn: 'arn:aws:secretsmanager:ap-southeast-2:123:secret:xero',
        enabled: true,
        connectedAt: now,
        lastSuccessfulAuthenticationAt: now
      },
      {
        organisationId: seeded.organisationId,
        provider: 'SINCH',
        secretArn: 'arn:aws:secretsmanager:ap-southeast-2:123:secret:sinch',
        enabled: true,
        connectedAt: now,
        lastSuccessfulAuthenticationAt: now
      }
    ]);
    await service.updateAllowlist(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      recipients: ['0400 000 001']
    });
    await service.activateLive(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      acknowledgement: LIVE_ACKNOWLEDGEMENT
    });
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: true,
      recipientAllowlist: [controlledNumber]
    });
  });

  it('records exact current-sync reconciliation metrics before customer activation', async () => {
    const seeded = await seedCustomerRolloutReady();
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => now }
    });
    const before = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId,
      now
    });

    expect(before.metrics).toEqual({
      activeContactCount: 1,
      outstandingInvoiceCount: 2,
      outstandingTotals: { AUD: '150.2500', USD: '42.5000' },
      generatedApprovalCount: 1,
      enabledSequenceCount: 1,
      allEnabledSequencesReview: true
    });
    expect(before.gates.reconciliationCurrent.passed).toBe(false);
    expect(before.gates.controlledSmsEvidence.evidence).toEqual({
      id: seeded.controlledSmsId,
      status: 'ACCEPTED',
      timestamp: new Date(now.getTime() - 2 * 60 * 60_000)
    });
    expect(JSON.stringify(before)).not.toContain(controlledNumber);
    expect(JSON.stringify(before)).not.toContain('Private test content');

    await expect(
      service.acknowledgeReconciliation(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        acknowledgement: RECONCILIATION_ACKNOWLEDGEMENT,
        expectedVersion: 3,
        expected: {
          syncCompletedAt: syncCompletedAt.toISOString(),
          metrics: before.metrics
        }
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      service.acknowledgeReconciliation(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: 'yes',
        expectedVersion: 3,
        expected: {
          syncCompletedAt: syncCompletedAt.toISOString(),
          metrics: before.metrics
        }
      })
    ).rejects.toThrow('RECONCILIATION_ACKNOWLEDGEMENT_MISMATCH');
    await expect(
      service.acknowledgeReconciliation(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: RECONCILIATION_ACKNOWLEDGEMENT,
        expectedVersion: 2,
        expected: {
          syncCompletedAt: syncCompletedAt.toISOString(),
          metrics: before.metrics
        }
      })
    ).rejects.toThrow('OPERATIONAL_STATE_CONFLICT');

    await service.acknowledgeReconciliation(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      acknowledgement: RECONCILIATION_ACKNOWLEDGEMENT,
      expectedVersion: 3,
      expected: {
        syncCompletedAt: syncCompletedAt.toISOString(),
        metrics: before.metrics
      }
    });

    const [reconciliation] = await client.db
      .select()
      .from(rolloutReconciliations)
      .where(
        eq(rolloutReconciliations.organisationId, seeded.organisationId)
      );
    expect(reconciliation).toMatchObject({
      syncCompletedAt,
      activeContactCount: 1,
      outstandingInvoiceCount: 2,
      outstandingTotals: { AUD: '150.2500', USD: '42.5000' },
      generatedApprovalCount: 1,
      enabledSequenceCount: 1,
      allEnabledSequencesReview: true,
      acknowledgedByUserId: seeded.userId,
      acknowledgedAt: now
    });
    const after = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId,
      now
    });
    expect(after.readyForCustomerAcknowledgement).toBe(true);
    expect(after.gates.reconciliationCurrent.passed).toBe(true);
  });

  it('refuses superseded figures and re-evaluates every customer gate', async () => {
    const seeded = await seedCustomerRolloutReady();
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => now }
    });
    const readiness = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId,
      now
    });
    await expect(
      service.acknowledgeReconciliation(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: RECONCILIATION_ACKNOWLEDGEMENT,
        expectedVersion: 3,
        expected: {
          syncCompletedAt: syncCompletedAt.toISOString(),
          metrics: { ...readiness.metrics, outstandingInvoiceCount: 99 }
        }
      })
    ).rejects.toThrow('RECONCILIATION_METRICS_CHANGED');
    await expect(
      service.acknowledgeReconciliation(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: RECONCILIATION_ACKNOWLEDGEMENT,
        expectedVersion: 3,
        expected: {
          syncCompletedAt: new Date(
            syncCompletedAt.getTime() - 60_000
          ).toISOString(),
          metrics: readiness.metrics
        }
      })
    ).rejects.toThrow('SYNC_SUPERSEDED');

    await client.db
      .update(providerConnections)
      .set({
        lastSuccessfulAuthenticationAt: new Date(
          now.getTime() - 25 * 60 * 60_000
        )
      })
      .where(
        and(
          eq(providerConnections.organisationId, seeded.organisationId),
          eq(providerConnections.provider, 'SINCH')
        )
      );
    await client.db
      .update(reminderSequences)
      .set({ mode: 'AUTOMATIC' })
      .where(eq(reminderSequences.id, seeded.sequenceId));
    await client.db.insert(operationalResetRuns).values({
      organisationId: seeded.organisationId,
      status: 'PREPARING',
      requestedByUserId: seeded.userId,
      deployedCommit: 'abcdef1'
    });
    const blocked = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId,
      now
    });
    expect(blocked.gates.providersHealthy.passed).toBe(false);
    expect(blocked.gates.enabledSequencesReview.passed).toBe(false);
    expect(blocked.gates.resetIdle.passed).toBe(false);
    expect(blocked.readyForCustomerAcknowledgement).toBe(false);
  });

  it('fails freshness, imported-data, and allowlisted-SMS gates independently', async () => {
    const seeded = await seedCustomerRolloutReady();
    await client.db
      .update(organisations)
      .set({ lastSuccessfulSyncAt: new Date(now.getTime() - 16 * 60_000) })
      .where(eq(organisations.id, seeded.organisationId));
    await client.db
      .delete(outboundMessages)
      .where(eq(outboundMessages.organisationId, seeded.organisationId));
    await client.db
      .delete(invoices)
      .where(eq(invoices.organisationId, seeded.organisationId));

    const blocked = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId,
      now
    });
    expect(blocked.gates.syncFresh.passed).toBe(false);
    expect(blocked.gates.importedDataPresent.passed).toBe(false);
    expect(blocked.gates.controlledSmsEvidence.passed).toBe(false);
  });

  it('requires all gates and exact final acknowledgement with stale-page refusal', async () => {
    const seeded = await seedCustomerRolloutReady();
    const service = await reconcile(seeded);

    await expect(
      service.activateCustomerRollout(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
        expectedVersion: 4
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      service.activateCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: LIVE_ACKNOWLEDGEMENT,
        expectedVersion: 4
      })
    ).rejects.toThrow('CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT_MISMATCH');
    await expect(
      service.activateCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
        expectedVersion: 3
      })
    ).rejects.toThrow('OPERATIONAL_STATE_CONFLICT');

    await client.db
      .update(providerConnections)
      .set({ enabled: false })
      .where(
        and(
          eq(providerConnections.organisationId, seeded.organisationId),
          eq(providerConnections.provider, 'SINCH')
        )
      );
    await expect(
      service.activateCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
        expectedVersion: 4
      })
    ).rejects.toThrow('CUSTOMER_ROLLOUT_NOT_READY:providersHealthy');
    await client.db
      .update(providerConnections)
      .set({ enabled: true })
      .where(
        and(
          eq(providerConnections.organisationId, seeded.organisationId),
          eq(providerConnections.provider, 'SINCH')
        )
      );

    await client.db
      .update(invoices)
      .set({ amountDue: '151.2500' })
      .where(
        and(
          eq(invoices.organisationId, seeded.organisationId),
          eq(invoices.currency, 'AUD')
        )
      );
    await expect(
      service.activateCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
        expectedVersion: 4
      })
    ).rejects.toThrow('CUSTOMER_ROLLOUT_NOT_READY:reconciliationCurrent');
    await client.db
      .update(invoices)
      .set({ amountDue: '150.2500' })
      .where(
        and(
          eq(invoices.organisationId, seeded.organisationId),
          eq(invoices.currency, 'AUD')
        )
      );

    await service.activateCustomerRollout(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
      expectedVersion: 4
    });
    await expect(
      service.activateLive(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: LIVE_ACKNOWLEDGEMENT,
        expectedVersion: 5
      })
    ).rejects.toThrow('CUSTOMER_ROLLOUT_REQUIRES_REASONED_ROLLBACK');
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CUSTOMER',
      liveSendAcknowledged: true,
      operationalState: 'RECONCILED',
      operationalStateVersion: 5
    });
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    const activated = events.find(
      (event) => event.eventType === 'CUSTOMER_ROLLOUT_ACTIVATED'
    );
    expect(activated?.afterValue).toMatchObject({
      beforeScope: 'CONTROLLED',
      afterScope: 'CUSTOMER',
      syncCompletedAt: syncCompletedAt.toISOString(),
      controlledSmsEvidenceId: seeded.controlledSmsId,
      enabledSequenceCount: 1
    });
    expect(JSON.stringify(activated)).not.toContain(controlledNumber);
    expect(JSON.stringify(activated)).not.toContain(
      CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT
    );
  });

  it('waits for sequence changes and refuses activation if one becomes automatic', async () => {
    const seeded = await seedCustomerRolloutReady();
    const service = await reconcile(seeded);
    const locked = deferred();
    const release = deferred();
    const blocker = client.db.transaction(async (transaction) => {
      await transaction
        .update(reminderSequences)
        .set({ mode: 'AUTOMATIC' })
        .where(eq(reminderSequences.id, seeded.sequenceId));
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    let settled = false;
    const outcome = service
      .activateCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
        expectedVersion: 4
      })
      .then(
        () => {
          settled = true;
          return { error: null };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledBeforeRelease = settled;
    release.resolve();
    await blocker;
    const result = await outcome;
    expect(settledBeforeRelease).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain(
      'enabledSequencesReview'
    );
  });

  it('uses the decision time after waiting for evidence locks', async () => {
    const seeded = await seedCustomerRolloutReady();
    await reconcile(seeded);
    let decisionTime = now;
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => decisionTime }
    });
    const locked = deferred();
    const release = deferred();
    const blocker = client.db.transaction(async (transaction) => {
      await transaction
        .update(providerConnections)
        .set({ updatedAt: now })
        .where(
          and(
            eq(providerConnections.organisationId, seeded.organisationId),
            eq(providerConnections.provider, 'SINCH')
          )
        );
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const outcome = service
      .activateCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
        expectedVersion: 4
      })
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error })
      );
    decisionTime = new Date(now.getTime() + 16 * 60_000);
    release.resolve();
    await blocker;
    const result = await outcome;
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('syncFresh');
  });

  it('returns safely to controlled live and can atomically disable all providers', async () => {
    const seeded = await seedCustomerRolloutReady();
    const service = await reconcile(seeded);
    await service.activateCustomerRollout(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
      expectedVersion: 4
    });
    const privateReason = 'Call Jane on 0400 999 999 about invoice 123';

    await expect(
      service.returnToControlledLive(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        reason: ' ',
        expectedVersion: 5
      })
    ).rejects.toThrow('REASON_REQUIRED');
    await expect(
      service.returnToControlledLive(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        reason: 'Safety rollback',
        expectedVersion: 5
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      service.returnToControlledLive(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        reason: 'Safety rollback',
        expectedVersion: 4
      })
    ).rejects.toThrow('OPERATIONAL_STATE_CONFLICT');
    await service.returnToControlledLive(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      reason: privateReason,
      expectedVersion: 5
    });
    let [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: true,
      recipientAllowlist: [controlledNumber],
      operationalStateVersion: 6
    });

    await service.activateCustomerRollout(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
      expectedVersion: 6
    });
    await expect(
      service.disableAllProviderSending(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        reason: '',
        expectedVersion: 7
      })
    ).rejects.toThrow('REASON_REQUIRED');
    await expect(
      service.disableAllProviderSending(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        reason: 'Emergency stop',
        expectedVersion: 6
      })
    ).rejects.toThrow('OPERATIONAL_STATE_CONFLICT');
    await service.disableAllProviderSending(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      reason: privateReason,
      expectedVersion: 7
    });
    [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'dry-run',
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: false,
      recipientAllowlist: [controlledNumber],
      operationalStateVersion: 8
    });
    const [contact] = await client.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, seeded.contactId));
    const [sequence] = await client.db
      .select()
      .from(reminderSequences)
      .where(eq(reminderSequences.id, seeded.sequenceId));
    expect(contact).toBeDefined();
    expect(sequence).toMatchObject({ mode: 'REVIEW', enabled: true });
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'CUSTOMER_ROLLOUT_RETURNED_TO_CONTROLLED',
        'ALL_PROVIDER_SENDING_DISABLED'
      ])
    );
    expect(JSON.stringify(events)).not.toContain(privateReason);
    expect(JSON.stringify(events)).not.toContain(controlledNumber);
  });
});
