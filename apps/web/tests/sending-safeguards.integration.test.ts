import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  approvals,
  auditEvents,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  messageAttempts,
  migrateDatabase,
  operationalResetRuns,
  organisationOnboarding,
  organisations,
  outboundMessages,
  PostgresPlatformAdminRepository,
  PostgresSmsCommerceRepository,
  providerConnections,
  reminderSequences,
  reminderSequenceVersions,
  rolloutReconciliations,
  smsNumberPool,
  stageInstances,
  subscriptions,
  users,
  xeroConnections,
  xeroPendingAuthorisations
} from '@bc5000/db';

import {
  createSendingSettings,
  CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
  CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
  getCustomerRolloutReadiness,
  liveActivationFeedback,
  LIVE_ACKNOWLEDGEMENT,
  RECONCILIATION_ACKNOWLEDGEMENT
} from '../src/app/(protected)/settings/sending/sending-settings.js';
import { createPostgresSoloProvisioningRepository } from '../src/server/solo-provisioning-service.js';

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
    memberships: [{ organisationId, role, active: true, organisationStatus: 'ACTIVE' }]
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

  const imported = await seedImportedReceivables(seeded.organisationId);
  const controlledSmsId = await recordTestSms(seeded, new Date(now.getTime() - 2 * 60 * 60_000));
  return { ...seeded, ...imported, controlledSmsId };
}

async function seedImportedReceivables(organisationId: string) {
  const contactId = randomUUID();
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Reconciliation customer',
    active: true
  });
  const audInvoiceId = randomUUID();
  await client.db.insert(invoices).values([
    {
      id: audInvoiceId,
      organisationId,
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
      organisationId,
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
      organisationId,
      name: `Review sequence ${randomUUID()}`,
      mode: 'REVIEW',
      enabled: true
    },
    {
      organisationId,
      name: `Disabled automatic ${randomUUID()}`,
      mode: 'AUTOMATIC',
      enabled: false
    }
  ]);
  const [version] = await client.db
    .insert(reminderSequenceVersions)
    .values({
      organisationId,
      sequenceId,
      versionNumber: 1,
      status: 'ACTIVE'
    })
    .returning({ id: reminderSequenceVersions.id });
  if (!version) throw new Error('TEST_SEQUENCE_VERSION_NOT_CREATED');
  const [chase] = await client.db
    .insert(invoiceChases)
    .values({
      organisationId,
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
      organisationId,
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
    organisationId,
    stageInstanceId: stage.id,
    renderedPreview: 'Not exposed in readiness or audit output',
    sourceVersion: 1,
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + 60 * 60_000)
  });
  return { contactId, sequenceId };
}

async function recordTestSms(
  seeded: { organisationId: string; userId: string },
  sentAt: Date
) {
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
      completedAt: sentAt,
      createdAt: sentAt,
      updatedAt: sentAt
    })
    .returning({ id: outboundMessages.id });
  if (!controlledSms) throw new Error('TEST_SMS_NOT_CREATED');

  return controlledSms.id;
}

async function reconcile(
  seeded: { organisationId: string; session(role: 'ADMIN'): AppSession }
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

const soloConnectedAt = new Date(now.getTime() - 3 * 24 * 60 * 60_000);
const soloNumberReadyAt = new Date(now.getTime() - 2 * 24 * 60 * 60_000);
const soloOnboardingCompletedAt = new Date(now.getTime() - 10 * 60_000);
const dedicatedTestAt = new Date(now.getTime() - 60_000);
const tokenEnvelope = {
  version: 1,
  keyId: 'integration-test',
  iv: Buffer.alloc(12).toString('base64'),
  ciphertext: Buffer.from('encrypted-refresh-token').toString('base64'),
  tag: Buffer.alloc(16).toString('base64')
};

async function seedOwnerCreatedSolo() {
  const owner = await seedBasic();
  const connectionId = randomUUID();
  const tenantId = randomUUID();
  const [pending] = await client.db
    .insert(xeroPendingAuthorisations)
    .values({
      userId: owner.userId,
      flowPurpose: 'NEW_SOLO',
      encryptedRefreshToken: tokenEnvelope,
      candidateTenants: [{
        connectionId,
        tenantId,
        tenantName: 'Solo workspace',
        tenantType: 'ORGANISATION',
        xeroOrganisationId: randomUUID(),
        organisationName: 'Solo workspace',
        baseCurrency: 'AUD',
        timeZone: 'Australia/Sydney'
      }],
      grantedScopes: ['offline_access', 'accounting.invoices'],
      expiresAt: now
    })
    .returning({ id: xeroPendingAuthorisations.id });
  if (!pending) throw new Error('TEST_XERO_AUTHORISATION_NOT_CREATED');
  const { organisationId } = await createPostgresSoloProvisioningRepository(client.db)
    .provision({
      userId: owner.userId,
      pendingAuthorisationId: pending.id,
      connectionId,
      tenantId,
      now: soloConnectedAt
    });
  const session = (): AppSession => ({
    ...owner.session('ADMIN'),
    memberships: [{ organisationId, role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }]
  });
  await client.db.update(organisations)
    .set({
      operationalState: 'RECONCILIATION_REQUIRED',
      operationalStateVersion: 2,
      recipientAllowlist: [controlledNumber],
      lastSuccessfulSyncAt: syncCompletedAt
    })
    .where(eq(organisations.id, organisationId));

  const numberSuffix = String(parseInt(randomUUID().slice(0, 8), 16))
    .slice(-8).padStart(8, '0');
  const [number] = await client.db.insert(smsNumberPool).values({
    organisationId,
    e164Number: '+614' + numberSuffix,
    provider: 'SINCH',
    status: 'RESERVED',
    reservedAt: soloNumberReadyAt,
    updatedAt: soloNumberReadyAt
  }).returning({ id: smsNumberPool.id });
  if (!number) throw new Error('TEST_REPLY_NUMBER_NOT_CREATED');
  const result = await new PostgresPlatformAdminRepository(client.db).markSmsNumberReady({
    organisationId,
    numberId: number.id,
    actorUserId: owner.userId,
    providerNumberId: randomUUID(),
    expectedStatus: 'RESERVED',
    expectedUpdatedAt: soloNumberReadyAt,
    reason: 'Verified test number',
    now: soloNumberReadyAt
  });
  expect(result.ok).toBe(true);

  await client.db.update(subscriptions)
    .set({
      status: 'ACTIVE',
      stripeProviderStatus: 'active',
      currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z')
    })
    .where(eq(subscriptions.organisationId, organisationId));
  await client.db.update(organisationOnboarding)
    .set({
      completedVersion: 1,
      completedAt: soloOnboardingCompletedAt,
      adminMobile: controlledNumber,
      adminMobileVerifiedAt: soloNumberReadyAt
    })
    .where(eq(organisationOnboarding.organisationId, organisationId));

  return { organisationId, userId: owner.userId, session, numberId: number.id };
}

async function recordDedicatedTestSms(
  seeded: Awaited<ReturnType<typeof seedOwnerCreatedSolo>>,
  sentAt: Date
) {
  const outboundMessageId = await recordTestSms(seeded, sentAt);
  const smsCommerce = new PostgresSmsCommerceRepository(client.db);
  expect(await smsCommerce.reserveUsage({
    organisationId: seeded.organisationId,
    outboundMessageId,
    source: 'TEST_SMS',
    partCount: 1,
    now: sentAt
  })).toMatchObject({ kind: 'reserved' });
  await smsCommerce.commitUsage(seeded.organisationId, outboundMessageId, sentAt);
  return outboundMessageId;
}

describe('owner-created Solo rollout', () => {
  const sending = () => createSendingSettings({
    database: client.db,
    clock: { now: () => now }
  });

  const activate = (seeded: Awaited<ReturnType<typeof seedOwnerCreatedSolo>>) =>
    sending().activateLive(seeded.session(), {
      organisationId: seeded.organisationId,
      acknowledgement: LIVE_ACKNOWLEDGEMENT,
      expectedVersion: 2
    });

  const approve = (
    seeded: Awaited<ReturnType<typeof seedOwnerCreatedSolo>>,
    service = sending()
  ) => service.activateCustomerRollout(seeded.session(), {
    organisationId: seeded.organisationId,
    acknowledgement: CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
    expectedVersion: 4
  });

  const prepareSoloApproval = async () => {
    const seeded = await seedOwnerCreatedSolo();
    await seedImportedReceivables(seeded.organisationId);
    await activate(seeded);
    const service = await reconcile(seeded);
    const testId = await recordDedicatedTestSms(seeded, dedicatedTestAt);
    return { seeded, service, testId };
  };

  it('activates Controlled Live and Customer Live using only native evidence', async () => {
    const seeded = await seedOwnerCreatedSolo();
    await seedImportedReceivables(seeded.organisationId);
    await expect(client.db.select().from(providerConnections)
      .where(eq(providerConnections.organisationId, seeded.organisationId))).resolves.toEqual([]);

    await activate(seeded);
    const service = await reconcile(seeded);
    const testId = await recordDedicatedTestSms(seeded, dedicatedTestAt);
    await expect(getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId, now
    })).resolves.toMatchObject({
      readyForCustomerAcknowledgement: true,
      gates: { controlledSmsEvidence: { evidence: { id: testId } } }
    });
    await approve(seeded, service);
    const [organisation] = await client.db.select().from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      edition: 'SOLO',
      sendMode: 'live',
      rolloutScope: 'CUSTOMER'
    });
  });

  it.each([
    ['disconnected', { status: 'DISCONNECTED', encryptedRefreshToken: null }],
    ['owned by another workspace', { organisationId: 'other' }],
    ['in need of reauthorisation', { status: 'REAUTH_REQUIRED' }]
  ] as const)('refuses a Xero connection that is %s', async (_, change) => {
    const seeded = await seedOwnerCreatedSolo();
    const xeroChange = 'organisationId' in change
      ? { organisationId: (await seedBasic()).organisationId }
      : change;
    await client.db.update(xeroConnections)
      .set(xeroChange)
      .where(eq(xeroConnections.organisationId, seeded.organisationId));

    await expect(activate(seeded)).rejects.toThrow('PROVIDERS_UNHEALTHY');
    const readiness = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId, now
    });
    expect(readiness.gates.providersHealthy.passed).toBe(false);
  });

  it.each([
    ['no successful sync', null, soloConnectedAt, false],
    ['sync before reconnect', syncCompletedAt, new Date(syncCompletedAt.getTime() + 1), false],
    ['stale sync', new Date(now.getTime() - 15 * 60_000 - 1), soloConnectedAt, false],
    ['future sync', new Date(now.getTime() + 1), soloConnectedAt, false],
    ['sync exactly 15 minutes old and as recent as connection', new Date(now.getTime() - 15 * 60_000), new Date(now.getTime() - 15 * 60_000), true]
  ] as const)('checks Xero freshness with %s', async (_, syncAt, connectedAt, expected) => {
    const seeded = await seedOwnerCreatedSolo();
    await client.db.update(xeroConnections)
      .set({ connectedAt, lastRefreshedAt: now })
      .where(eq(xeroConnections.organisationId, seeded.organisationId));
    await client.db.update(organisations)
      .set({ lastSuccessfulSyncAt: syncAt })
      .where(eq(organisations.id, seeded.organisationId));

    const readiness = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId, now
    });
    expect(readiness.gates.syncFresh.passed).toBe(expected);
    if (expected) await expect(activate(seeded)).resolves.toBeUndefined();
    else await expect(activate(seeded)).rejects.toThrow('XERO_SYNC_STALE');
  });

  it.each([
    ['missing', { organisationId: null, status: 'AVAILABLE' }],
    ['unverified', { providerVerifiedAt: null }],
    ['quarantined', { status: 'QUARANTINED' }],
    ['owned by another workspace', { organisationId: 'other' }],
    ['missing ready time', { readyAt: null }],
    ['missing provider ID', { providerNumberId: null, providerVerifiedAt: null }],
    ['blank provider ID', { providerNumberId: '  ', provider: randomUUID().slice(0, 32) }],
    ['blank provider name', { provider: '' }]
  ] as const)('refuses a reply number that is %s', async (_, change) => {
    const seeded = await seedOwnerCreatedSolo();
    const numberChange = 'organisationId' in change && change.organisationId === 'other'
      ? { organisationId: (await seedBasic()).organisationId }
      : change;
    await client.db.update(smsNumberPool)
      .set(numberChange)
      .where(eq(smsNumberPool.id, seeded.numberId));

    await expect(activate(seeded)).rejects.toThrow('PROVIDERS_UNHEALTHY');
    const readiness = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId, now
    });
    expect(readiness.gates.providersHealthy.passed).toBe(false);
  });

  it('requires a dedicated-number test after onboarding and retains the seven-day window', async () => {
    const seeded = await seedOwnerCreatedSolo();
    await seedImportedReceivables(seeded.organisationId);
    await activate(seeded);
    const service = await reconcile(seeded);
    await recordTestSms(seeded, new Date(soloOnboardingCompletedAt.getTime() - 1));
    await recordTestSms(seeded, dedicatedTestAt);
    const before = await getCustomerRolloutReadiness(client.db, {
      organisationId: seeded.organisationId, now
    });
    expect(before.gates.controlledSmsEvidence.passed).toBe(false);
    await expect(approve(seeded, service)).rejects.toThrow(
      'CUSTOMER_ROLLOUT_NOT_READY:controlledSmsEvidence'
    );

    const testId = await recordDedicatedTestSms(seeded, dedicatedTestAt);
    const cutoff = dedicatedTestAt.getTime() + 7 * 24 * 60 * 60_000;
    for (const [offset, expected] of [[0, true], [1, false]] as const) {
      const readiness = await getCustomerRolloutReadiness(client.db, {
        organisationId: seeded.organisationId, now: new Date(cutoff + offset)
      });
      expect(readiness.gates.controlledSmsEvidence).toEqual(expected
        ? { passed: true, evidence: { id: testId, status: 'ACCEPTED', timestamp: dedicatedTestAt } }
        : { passed: false, evidence: null });
    }
  });

  it('keeps Customer Live gated on paid entitlement even with all native evidence', async () => {
    const seeded = await seedOwnerCreatedSolo();
    await seedImportedReceivables(seeded.organisationId);
    await activate(seeded);
    const service = await reconcile(seeded);
    await recordDedicatedTestSms(seeded, dedicatedTestAt);
    await client.db.update(subscriptions).set({ status: 'PAST_DUE' })
      .where(eq(subscriptions.organisationId, seeded.organisationId));

    await expect(approve(seeded, service)).rejects.toThrow('PAYMENT_PAST_DUE');
  });

  it('does not hold Xero while waiting for a sending worker holding the organisation', async () => {
    const { seeded, service } = await prepareSoloApproval();
    const organisationLocked = deferred();
    const refresh = deferred();
    const emailWorker = client.db.transaction(async (transaction) => {
      await transaction.select().from(organisations)
        .where(eq(organisations.id, seeded.organisationId)).for('update');
      organisationLocked.resolve();
      await refresh.promise;
      // OAuth refresh obtains the lease using its own connection.
      await client.db.transaction(async (lease) => {
        await lease.execute(sql`set local lock_timeout = '500ms'`);
        await lease.update(xeroConnections).set({ lastRefreshedAt: now })
          .where(eq(xeroConnections.organisationId, seeded.organisationId));
      });
    }).then(() => null, (error: unknown) => error);
    await organisationLocked.promise;
    const outcome = approve(seeded, service).then(() => null, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    refresh.resolve();
    expect(await emailWorker).toBeNull();
    expect(await outcome).toBeNull();
  });

  it('refuses busy Xero evidence and rejects the pre-reconnect sync after retry', async () => {
    const { seeded, service } = await prepareSoloApproval();
    const connectionLocked = deferred();
    const finishReconnect = deferred();
    const reconnect = client.db.transaction(async (transaction) => {
      await transaction.update(xeroConnections).set({ connectedAt: now })
        .where(eq(xeroConnections.organisationId, seeded.organisationId));
      connectionLocked.resolve();
      await finishReconnect.promise;
      await transaction.update(organisations).set({ updatedAt: now })
        .where(eq(organisations.id, seeded.organisationId));
    });
    await connectionLocked.promise;
    const outcome = approve(seeded, service).then(() => null, (error: unknown) => error);
    const firstResult = await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500))
    ]);
    finishReconnect.resolve();
    await reconnect;
    await outcome;
    expect(firstResult).toMatchObject({ message: 'OPERATIONAL_STATE_CONFLICT' });
    await expect(approve(seeded, service)).rejects.toThrow(
      'CUSTOMER_ROLLOUT_NOT_READY:syncFresh'
    );
  });

  it('rechecks paid entitlement when the cancellation cutoff elapses during an evidence wait', async () => {
    const { seeded } = await prepareSoloApproval();
    const cutoff = new Date(now.getTime() + 1000);
    await client.db.update(subscriptions).set({ cancelAt: cutoff })
      .where(eq(subscriptions.organisationId, seeded.organisationId));

    const numberLocked = deferred();
    const release = deferred();
    const blocker = client.db.transaction(async (transaction) => {
      await transaction.select().from(smsNumberPool)
        .where(eq(smsNumberPool.id, seeded.numberId)).for('update');
      numberLocked.resolve();
      await release.promise;
    });
    await numberLocked.promise;

    let decisionTime = now;
    const entitlementClockRead = deferred();
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => {
        entitlementClockRead.resolve();
        return decisionTime;
      } }
    });
    const outcome = approve(seeded, service).then(() => null, (error: unknown) => error);
    try {
      await Promise.race([
        entitlementClockRead.promise,
        new Promise((resolve) => setTimeout(resolve, 300))
      ]);
      decisionTime = cutoff;
    } finally {
      release.resolve();
      await blocker;
    }
    expect(await outcome).toMatchObject({ message: 'SUBSCRIPTION_REQUIRED' });
    const [organisation] = await client.db.select().from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation?.rolloutScope).toBe('CONTROLLED');
  });

  it('waits for a worker claim without blocking its organisation FK or accepting a queued test', async () => {
    const { seeded, testId } = await prepareSoloApproval();
    await client.db.update(outboundMessages).set({ status: 'QUEUED', completedAt: null })
      .where(eq(outboundMessages.id, testId));
    const messageLocked = deferred();
    const finishClaim = deferred();
    const workerClaim = client.db.transaction(async (transaction) => {
      await transaction.execute(sql`set local lock_timeout = '500ms'`);
      await transaction.select().from(outboundMessages)
        .where(eq(outboundMessages.id, testId)).for('update');
      messageLocked.resolve();
      await finishClaim.promise;
      await transaction.insert(messageAttempts).values({
        organisationId: seeded.organisationId,
        outboundMessageId: testId,
        attemptNumber: 1,
        provider: 'SINCH',
        status: 'SENDING'
      });
      await transaction.update(outboundMessages).set({ status: 'SENDING' })
        .where(eq(outboundMessages.id, testId));
    }).then(() => null, (error: unknown) => error);
    await messageLocked.promise;
    const organisationLocked = deferred();
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => {
        organisationLocked.resolve();
        return now;
      } }
    });
    const outcome = approve(seeded, service).then(() => null, (error: unknown) => error);
    try {
      await Promise.race([
        organisationLocked.promise,
        new Promise((resolve) => setTimeout(resolve, 300))
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      finishClaim.resolve();
    }
    expect(await workerClaim).toBeNull();
    expect(await outcome).toMatchObject({
      message: 'CUSTOMER_ROLLOUT_NOT_READY:controlledSmsEvidence'
    });
  });

  it('rechecks number revocation at final approval and forbids a Solo override', async () => {
    const seeded = await seedOwnerCreatedSolo();
    await seedImportedReceivables(seeded.organisationId);
    await activate(seeded);
    const service = await reconcile(seeded);
    await recordDedicatedTestSms(seeded, dedicatedTestAt);
    await client.db.update(smsNumberPool).set({ status: 'QUARANTINED' })
      .where(eq(smsNumberPool.id, seeded.numberId));

    await expect(approve(seeded, service)).rejects.toThrow(
      'CUSTOMER_ROLLOUT_NOT_READY:providersHealthy'
    );
    await expect(service.overrideCustomerRollout(seeded.session(), {
      organisationId: seeded.organisationId,
      acknowledgement: CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
      reason: 'Check the Solo gate',
      expectedVersion: 4
    })).rejects.toThrow('FORBIDDEN');
  });
});

describe('global sending safeguards', () => {
  it('explains controlled-live refusals without exposing internal errors', () => {
    expect(liveActivationFeedback('PROVIDERS_UNHEALTHY')).toMatchObject({
      tone: 'error',
      title: 'Connection checks are out of date'
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

  it('allows only an administrator to override setup gates while retaining reset locks and audit privacy', async () => {
    const seeded = await seedCustomerRolloutReady();
    const service = createSendingSettings({
      database: client.db,
      clock: { now: () => now }
    });
    await client.db
      .update(providerConnections)
      .set({ enabled: false })
      .where(eq(providerConnections.organisationId, seeded.organisationId));
    await client.db
      .update(reminderSequences)
      .set({ mode: 'AUTOMATIC' })
      .where(eq(reminderSequences.id, seeded.sequenceId));
    const privateReason = 'Approved by Jane on 0400 111 222 for invoice 999';

    await expect(
      service.overrideCustomerRollout(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
        reason: privateReason,
        expectedVersion: 3
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      service.overrideCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: 'enable it',
        reason: privateReason,
        expectedVersion: 3
      })
    ).rejects.toThrow('CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT_MISMATCH');
    await expect(
      service.overrideCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
        reason: ' ',
        expectedVersion: 3
      })
    ).rejects.toThrow('REASON_REQUIRED');
    await expect(
      service.overrideCustomerRollout(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
        reason: privateReason,
        expectedVersion: 2
      })
    ).rejects.toThrow('OPERATIONAL_STATE_CONFLICT');

    await service.overrideCustomerRollout(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      acknowledgement: CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
      reason: privateReason,
      expectedVersion: 3
    });
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CUSTOMER',
      liveSendAcknowledged: true,
      operationalState: 'RECONCILIATION_REQUIRED',
      operationalStateVersion: 4
    });
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    const overridden = events.find(
      (event) => event.eventType === 'CUSTOMER_ROLLOUT_SETUP_OVERRIDE_ACTIVATED'
    );
    expect(overridden?.afterValue).toMatchObject({
      beforeScope: 'CONTROLLED',
      afterScope: 'CUSTOMER',
      reasonRecorded: true
    });
    const bypassedGates = (
      overridden?.afterValue as { bypassedGates?: unknown } | null
    )?.bypassedGates;
    expect(bypassedGates).toEqual([
      'providersHealthy',
      'enabledSequencesReview',
      'reconciliationCurrent'
    ]);
    expect(JSON.stringify(overridden)).not.toContain(privateReason);
    expect(JSON.stringify(overridden)).not.toContain(
      CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT
    );

    const resetSeeded = await seedCustomerRolloutReady();
    await client.db.insert(operationalResetRuns).values({
      organisationId: resetSeeded.organisationId,
      status: 'PREPARING',
      requestedByUserId: resetSeeded.userId,
      deployedCommit: 'abcdef1'
    });
    await expect(
      service.overrideCustomerRollout(resetSeeded.session('ADMIN'), {
        organisationId: resetSeeded.organisationId,
        acknowledgement: CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
        reason: 'Urgent approved rollout',
        expectedVersion: 3
      })
    ).rejects.toThrow('OPERATIONAL_MAINTENANCE');
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
