import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approvals,
  auditEvents,
  contactChannels,
  contacts,
  conversationAssignments,
  conversations,
  createDatabase,
  disputes,
  inboundMessages,
  invitations,
  invoiceChases,
  invoices,
  memberships,
  messageAttempts,
  operationalResetRuns,
  operatorReplies,
  organisations,
  outboundMessages,
  pauses,
  paymentPromises,
  providerConnections,
  reminderSequenceVersions,
  reminderSequences,
  reminderWhitelistEntries,
  rolloutReconciliations,
  sequenceExclusions,
  sequenceStages,
  stageInstances,
  suppressions,
  tasks,
  users,
  webhookEvents
} from '@bc5000/db';
import { DurableJobQueue, jobNames } from '@bc5000/jobs';

import {
  createOperationalResetService,
  OPERATIONAL_RESET_ACKNOWLEDGEMENT
} from '../src/operations/operational-reset.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const database = createDatabase(databaseUrl);
const queue = new DurableJobQueue({ databaseUrl });
const now = new Date('2026-09-29T00:30:00.000Z');
const clock = { now: () => now };

beforeAll(async () => {
  await queue.start();
});

afterAll(async () => {
  await queue.stop();
  await database.pool.end();
});

interface SeededGraph {
  organisationId: string;
  adminId: string;
  adminEmail: string;
  sequenceId: string;
  contactId: string;
  invoiceId: string;
}

const seedGraph = async (
  options: {
    sendMode?: 'dry-run' | 'live';
    rolloutScope?: 'CONTROLLED' | 'CUSTOMER';
  } = {}
): Promise<SeededGraph> => {
  const organisationId = randomUUID();
  const adminId = randomUUID();
  const adminEmail = `${adminId}@example.invalid`;
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const invoiceChaseId = randomUUID();
  const stageInstanceId = randomUUID();
  const conversationId = randomUUID();
  const replyOutboundMessageId = randomUUID();
  const testOutboundMessageId = randomUUID();
  const syncedAt = new Date(now.getTime() - 60_000);

  await database.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Operational reset test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: options.sendMode ?? 'live',
    rolloutScope: options.rolloutScope ?? 'CONTROLLED',
    liveSendAcknowledged: options.sendMode !== 'dry-run',
    recipientAllowlist: ['+61400000001'],
    xeroSyncCursor: 'cursor-before-reset',
    lastSuccessfulSyncAt: syncedAt,
    latestReconciledSyncAt: syncedAt
  });
  await database.db.insert(users).values({
    id: adminId,
    cognitoSubject: randomUUID(),
    email: adminEmail,
    displayName: 'Reset administrator'
  });
  await database.db.insert(memberships).values({
    organisationId,
    userId: adminId,
    role: 'ADMIN'
  });
  await database.db.insert(invitations).values({
    organisationId,
    email: `invited-${adminId}@example.invalid`,
    role: 'OPERATOR',
    invitedByUserId: adminId,
    expiresAt: new Date(now.getTime() + 86_400_000)
  });
  await database.db.insert(providerConnections).values([
    {
      organisationId,
      provider: 'XERO',
      secretArn: `arn:example:xero:${organisationId}`,
      connectedAt: syncedAt,
      lastSuccessfulAuthenticationAt: syncedAt
    },
    {
      organisationId,
      provider: 'SINCH',
      secretArn: `arn:example:sinch:${organisationId}`,
      region: 'APAC',
      connectedAt: syncedAt,
      lastSuccessfulAuthenticationAt: syncedAt
    }
  ]);
  await database.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: 'Standard sequence',
    mode: 'AUTOMATIC'
  });
  await database.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    createdByUserId: adminId
  });
  await database.db.insert(sequenceStages).values({
    organisationId,
    sequenceVersionId,
    stageKey: 'DUE',
    offsetDays: 0,
    channel: 'SMS',
    template: 'Reminder'
  });
  await database.db.insert(sequenceExclusions).values({
    organisationId,
    sequenceVersionId,
    kind: 'REFERENCE_PREFIX',
    value: `EX-${organisationId}`
  });
  await database.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Reset customer',
    email: `customer-${organisationId}@example.invalid`
  });
  await database.db.insert(contactChannels).values({
    organisationId,
    contactId,
    kind: 'SMS',
    sourceValue: '0400 000 002',
    normalisedValue: '+61400000002'
  });
  await database.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: `INV-${organisationId.slice(0, 8)}`,
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '100.0000',
    total: '100.0000',
    currency: 'AUD',
    syncVersion: 1
  });
  await database.db.insert(reminderWhitelistEntries).values({
    organisationId,
    scope: 'INVOICE',
    contactId,
    invoiceId,
    reason: 'Do not chase this invoice',
    createdByUserId: adminId
  });
  await database.db.insert(invoiceChases).values({
    id: invoiceChaseId,
    organisationId,
    invoiceId,
    sequenceId,
    customerId: contactId,
    status: 'ACTIVE'
  });
  await database.db.insert(stageInstances).values({
    id: stageInstanceId,
    organisationId,
    invoiceChaseId,
    sequenceVersionId,
    stageKey: 'DUE',
    channel: 'SMS',
    status: 'AWAITING_APPROVAL',
    scheduledAt: now,
    sourceVersion: 1
  });
  await database.db.insert(approvals).values({
    organisationId,
    stageInstanceId,
    renderedPreview: 'Sensitive preview removed by reset',
    sourceVersion: 1,
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + 86_400_000)
  });
  await database.db.insert(conversations).values({
    id: conversationId,
    organisationId,
    contactId,
    normalisedNumber: '+61400000002',
    assignedUserId: adminId,
    lastMessageAt: now
  });
  await database.db.insert(conversationAssignments).values({
    organisationId,
    conversationId,
    assignedUserId: adminId
  });
  await database.db.insert(inboundMessages).values({
    organisationId,
    conversationId,
    provider: 'SINCH',
    providerMessageId: randomUUID(),
    body: 'Sensitive inbound body',
    bodyHash: randomUUID(),
    providerPayload: { accepted: true },
    receivedAt: now
  });
  await database.db.insert(outboundMessages).values([
    {
      id: replyOutboundMessageId,
      organisationId,
      contactId,
      invoiceId,
      actorUserId: adminId,
      channel: 'SMS',
      source: 'INBOX_REPLY',
      recipientKey: '+61400000002',
      content: 'Sensitive reply body',
      idempotencyKey: randomUUID()
    },
    {
      id: testOutboundMessageId,
      organisationId,
      actorUserId: adminId,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: '+61400000001',
      content: 'Sensitive Test SMS body',
      idempotencyKey: randomUUID()
    }
  ]);
  await database.db.insert(messageAttempts).values({
    organisationId,
    outboundMessageId: testOutboundMessageId,
    attemptNumber: 1,
    provider: 'SINCH',
    status: 'ACCEPTED',
    providerMessageId: randomUUID()
  });
  await database.db.insert(operatorReplies).values({
    organisationId,
    conversationId,
    actorUserId: adminId,
    outboundMessageId: replyOutboundMessageId,
    content: 'Sensitive reply body',
    contentHash: randomUUID(),
    status: 'ACCEPTED',
    idempotencyKey: randomUUID()
  });
  await database.db.insert(pauses).values({
    organisationId,
    kind: 'MANUAL',
    scope: 'invoice',
    contactId,
    invoiceId,
    active: true,
    actorUserId: adminId
  });
  await database.db.insert(disputes).values({
    organisationId,
    contactId,
    invoiceId,
    status: 'OPEN',
    reason: 'Invoice disputed',
    recordedByUserId: adminId
  });
  await database.db.insert(paymentPromises).values({
    organisationId,
    contactId,
    promisedDate: '2026-10-01',
    graceDays: 2,
    status: 'ACTIVE',
    recordedByUserId: adminId
  });
  await database.db.insert(tasks).values({
    organisationId,
    kind: 'DEBT_ESCALATION',
    contactId,
    invoiceId,
    sequenceId,
    assignedUserId: adminId,
    summary: 'Call the customer'
  });
  await database.db.insert(suppressions).values({
    organisationId,
    channel: 'SMS',
    normalisedDestination: '+61400000002',
    source: 'CUSTOMER_REPLY',
    reason: 'STOP received',
    consentState: 'SUPPRESSED',
    recordedByUserId: adminId
  });
  await database.db.insert(webhookEvents).values({
    organisationId,
    provider: 'SINCH',
    providerEventKey: randomUUID(),
    bodyHash: randomUUID(),
    signatureValid: true,
    providerPayload: { securityEvidence: true }
  });
  await database.db.insert(auditEvents).values({
    organisationId,
    actorUserId: adminId,
    eventType: 'PROVIDER_CONNECTION_TESTED',
    entityType: 'PROVIDER_CONNECTION',
    entityId: organisationId,
    afterValue: { healthy: true },
    occurredAt: syncedAt
  });
  await database.db.insert(rolloutReconciliations).values({
    organisationId,
    syncCompletedAt: syncedAt,
    activeContactCount: 1,
    outstandingInvoiceCount: 1,
    outstandingTotals: { AUD: '100.0000' },
    generatedApprovalCount: 1,
    enabledSequenceCount: 1,
    allEnabledSequencesReview: false,
    acknowledgedByUserId: adminId,
    acknowledgedAt: syncedAt
  });

  return {
    organisationId,
    adminId,
    adminEmail,
    sequenceId,
    contactId,
    invoiceId
  };
};

const prepare = async (
  seeded: SeededGraph,
  resetRunId = randomUUID(),
  expectedVersion = 0
) => {
  const service = createOperationalResetService({
    database: database.db,
    clock
  });
  await service.prepare({
    organisationId: seeded.organisationId,
    resetRunId,
    deployedCommit: '0123456789abcdef0123456789abcdef01234567',
    adminEmail: seeded.adminEmail,
    acknowledgement: OPERATIONAL_RESET_ACKNOWLEDGEMENT,
    expectedVersion
  });
  return { service, resetRunId };
};

const countRows = async (tableName: string, organisationId: string) => {
  const result = await database.pool.query<{ count: string }>(
    `select count(*)::text as count from ${tableName} where organisation_id = $1`,
    [organisationId]
  );
  return Number(result.rows[0]?.count ?? '0');
};

describe('operational reset', { timeout: 15_000 }, () => {
  it('requires the exact acknowledgement, a current Admin, controlled live, and a matching state version', async () => {
    const seeded = await seedGraph();
    const operatorId = randomUUID();
    const operatorEmail = `${operatorId}@example.invalid`;
    await database.db.insert(users).values({
      id: operatorId,
      cognitoSubject: randomUUID(),
      email: operatorEmail,
      displayName: 'Reset operator'
    });
    await database.db.insert(memberships).values({
      organisationId: seeded.organisationId,
      userId: operatorId,
      role: 'OPERATOR'
    });
    const service = createOperationalResetService({ database: database.db, clock });
    const baseInput = {
      organisationId: seeded.organisationId,
      resetRunId: randomUUID(),
      deployedCommit: '0123456789abcdef0123456789abcdef01234567',
      adminEmail: seeded.adminEmail,
      acknowledgement: OPERATIONAL_RESET_ACKNOWLEDGEMENT,
      expectedVersion: 0
    };

    await expect(
      service.prepare({ ...baseInput, acknowledgement: 'not exact' })
    ).rejects.toThrow('ACKNOWLEDGEMENT_MISMATCH');
    await expect(
      service.prepare({ ...baseInput, adminEmail: 'unknown@example.invalid' })
    ).rejects.toThrow('ADMIN_REQUIRED');
    await expect(
      service.prepare({ ...baseInput, adminEmail: operatorEmail })
    ).rejects.toThrow('ADMIN_REQUIRED');
    await expect(
      service.prepare({ ...baseInput, expectedVersion: 9 })
    ).rejects.toThrow('OPERATIONAL_STATE_CONFLICT');

    await service.prepare(baseInput);
    await expect(service.prepare(baseInput)).resolves.toBeUndefined();
    const [organisation] = await database.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CONTROLLED',
      maintenanceMode: true,
      operationalState: 'RESET_PREPARING',
      operationalStateVersion: 1
    });
    await expect(
      service.prepare({ ...baseInput, resetRunId: randomUUID(), expectedVersion: 1 })
    ).rejects.toThrow('RESET_ALREADY_ACTIVE');

    const [run] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, baseInput.resetRunId));
    expect(run).toMatchObject({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.adminId,
      status: 'PREPARING',
      deployedCommit: baseInput.deployedCommit
    });
    const requested = await database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, seeded.organisationId),
          eq(auditEvents.eventType, 'PRODUCTION_OPERATIONAL_RESET_REQUESTED')
        )
      );
    expect(requested).toHaveLength(1);
    expect(JSON.stringify(requested[0])).not.toContain(seeded.adminEmail);
    expect(JSON.stringify(requested[0])).not.toContain(
      OPERATIONAL_RESET_ACKNOWLEDGEMENT
    );

    const dryRun = await seedGraph({ sendMode: 'dry-run' });
    await expect(prepare(dryRun)).rejects.toThrow('CONTROLLED_LIVE_REQUIRED');
    const customer = await seedGraph({ rolloutScope: 'CUSTOMER' });
    await expect(prepare(customer)).rejects.toThrow('CONTROLLED_LIVE_REQUIRED');
  });

  it('deletes only target operational data and jobs while preserving safety and configuration evidence', async () => {
    const target = await seedGraph();
    const foreign = await seedGraph();
    const { service, resetRunId } = await prepare(target);
    const targetJobId = await queue.enqueueUnique(
      jobNames.xeroInitialSync,
      { organisationId: target.organisationId },
      randomUUID()
    );
    const foreignJobId = await queue.enqueueUnique(
      jobNames.xeroInitialSync,
      { organisationId: foreign.organisationId },
      randomUUID()
    );
    const providerTestId = await queue.enqueueUnique(
      jobNames.providerConnectionTest,
      { organisationId: target.organisationId, provider: 'SINCH' },
      randomUUID()
    );

    const result = await service.execute({
      organisationId: target.organisationId,
      resetRunId,
      snapshotIdentifier: 'accountpulse-production-reset-1001'
    });

    expect(result.rowCountManifest).toEqual({
      reminder_whitelist_entries: 1,
      conversation_assignments: 1,
      inbound_messages: 1,
      operator_replies: 1,
      message_attempts: 1,
      outbound_messages: 2,
      approvals: 1,
      stage_instances: 1,
      invoice_chases: 1,
      tasks: 1,
      pauses: 1,
      disputes: 1,
      payment_promises: 1,
      conversations: 1,
      invoices: 1,
      contact_channels: 1,
      contacts: 1,
      reminder_sequences_reset: 1
    });
    expect(result.jobPurgeManifest[jobNames.xeroInitialSync]).toBe(1);
    for (const table of [
      'reminder_whitelist_entries',
      'conversation_assignments',
      'inbound_messages',
      'operator_replies',
      'message_attempts',
      'outbound_messages',
      'approvals',
      'stage_instances',
      'invoice_chases',
      'tasks',
      'pauses',
      'disputes',
      'payment_promises',
      'conversations',
      'invoices',
      'contact_channels',
      'contacts'
    ]) {
      expect(await countRows(table, target.organisationId), table).toBe(0);
      expect(await countRows(table, foreign.organisationId), table).toBeGreaterThan(0);
    }

    const preservedTables = [
      'memberships',
      'invitations',
      'provider_connections',
      'reminder_sequences',
      'reminder_sequence_versions',
      'sequence_stages',
      'sequence_exclusions',
      'suppressions',
      'webhook_events',
      'audit_events',
      'rollout_reconciliations',
      'operational_reset_runs'
    ];
    for (const table of preservedTables) {
      expect(await countRows(table, target.organisationId), table).toBeGreaterThan(0);
    }
    const [sequence] = await database.db
      .select()
      .from(reminderSequences)
      .where(eq(reminderSequences.id, target.sequenceId));
    expect(sequence?.mode).toBe('REVIEW');
    const [organisation] = await database.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, target.organisationId));
    expect(organisation).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: true,
      recipientAllowlist: ['+61400000001'],
      maintenanceMode: false,
      operationalState: 'SYNC_REQUIRED',
      xeroSyncCursor: null,
      lastSuccessfulSyncAt: null,
      latestReconciledSyncAt: null
    });
    expect(
      await database.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, target.adminId))
    ).toHaveLength(1);
    const [run] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(run).toMatchObject({
      status: 'COMPLETED',
      snapshotIdentifier: 'accountpulse-production-reset-1001',
      rowCountManifest: result.rowCountManifest,
      jobPurgeManifest: result.jobPurgeManifest
    });
    expect(await queue.findJobs(jobNames.xeroInitialSync, { id: targetJobId })).toHaveLength(0);
    expect(await queue.findJobs(jobNames.xeroInitialSync, { id: foreignJobId })).toHaveLength(1);
    expect(await queue.findJobs(jobNames.providerConnectionTest, { id: providerTestId })).toHaveLength(1);
    const completionAudit = await database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, target.organisationId),
          eq(auditEvents.eventType, 'PRODUCTION_OPERATIONAL_DATA_RESET')
        )
      );
    expect(completionAudit).toHaveLength(1);
    expect(completionAudit[0]?.afterValue).toMatchObject({
      snapshotIdentifier: 'accountpulse-production-reset-1001',
      rowCountManifest: result.rowCountManifest
    });
  });

  it('durably records snapshot and pre-delete counts before deletion can begin', async () => {
    const seeded = await seedGraph();
    const { resetRunId } = await prepare(seeded);
    const interruptedService = createOperationalResetService({
      database: database.db,
      clock,
      afterEvidenceRecorded: () => {
        throw new Error('SIMULATED_PROCESS_INTERRUPTION');
      }
    });

    await expect(
      interruptedService.execute({
        organisationId: seeded.organisationId,
        resetRunId,
        snapshotIdentifier: 'accountpulse-interruption-test'
      })
    ).rejects.toThrow('SIMULATED_PROCESS_INTERRUPTION');
    const [preparedRun] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(preparedRun).toMatchObject({
      status: 'SNAPSHOT_CREATED',
      snapshotIdentifier: 'accountpulse-interruption-test'
    });
    expect(preparedRun?.rowCountManifest).toMatchObject({
      contacts: 1,
      outbound_messages: 2
    });
    expect(await countRows('contacts', seeded.organisationId)).toBe(1);

    const service = createOperationalResetService({ database: database.db, clock });
    await service.execute({
      organisationId: seeded.organisationId,
      resetRunId,
      snapshotIdentifier: 'accountpulse-interruption-test'
    });
    expect(await countRows('contacts', seeded.organisationId)).toBe(0);
  });

  it('refuses inconsistent cross-organisation references before recording deletion evidence', async () => {
    const target = await seedGraph();
    const foreign = await seedGraph();
    const { service, resetRunId } = await prepare(target);
    await database.db
      .update(contactChannels)
      .set({ contactId: target.contactId })
      .where(eq(contactChannels.organisationId, foreign.organisationId));

    await expect(
      service.execute({
        organisationId: target.organisationId,
        resetRunId,
        snapshotIdentifier: 'accountpulse-cross-tenant-test'
      })
    ).rejects.toThrow('CROSS_ORGANISATION_REFERENCE');
    expect(await countRows('contacts', target.organisationId)).toBe(1);
    expect(await countRows('contact_channels', foreign.organisationId)).toBe(1);
    const [run] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(run).toMatchObject({
      status: 'PREPARING',
      snapshotIdentifier: null,
      rowCountManifest: {}
    });
  });

  it('rechecks cross-organisation references after durable evidence and rolls back safely', async () => {
    const target = await seedGraph();
    const foreign = await seedGraph();
    const { resetRunId } = await prepare(target);
    const service = createOperationalResetService({
      database: database.db,
      clock,
      afterEvidenceRecorded: async () => {
        await database.db
          .update(contactChannels)
          .set({ contactId: target.contactId })
          .where(eq(contactChannels.organisationId, foreign.organisationId));
      }
    });

    await expect(
      service.execute({
        organisationId: target.organisationId,
        resetRunId,
        snapshotIdentifier: 'accountpulse-cross-tenant-race'
      })
    ).rejects.toThrow('CROSS_ORGANISATION_REFERENCE');
    expect(await countRows('contacts', target.organisationId)).toBe(1);
    expect(await countRows('contact_channels', foreign.organisationId)).toBe(1);
    const [run] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(run).toMatchObject({
      status: 'FAILED',
      snapshotIdentifier: 'accountpulse-cross-tenant-race',
      failureCode: 'RESET_EXECUTION_FAILED'
    });
    expect(run?.rowCountManifest.contacts).toBe(1);
  });

  it('rolls back when operational counts drift after evidence is recorded', async () => {
    const seeded = await seedGraph();
    const { resetRunId } = await prepare(seeded);
    const service = createOperationalResetService({
      database: database.db,
      clock,
      afterEvidenceRecorded: async () => {
        await database.db.insert(contacts).values({
          organisationId: seeded.organisationId,
          xeroContactId: randomUUID(),
          name: 'Unexpected post-evidence contact'
        });
      }
    });

    await expect(
      service.execute({
        organisationId: seeded.organisationId,
        resetRunId,
        snapshotIdentifier: 'accountpulse-count-drift-test'
      })
    ).rejects.toThrow('RESET_ROW_COUNT_CHANGED');
    expect(await countRows('contacts', seeded.organisationId)).toBe(2);
    expect(await countRows('outbound_messages', seeded.organisationId)).toBe(2);
    const [run] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(run).toMatchObject({
      status: 'FAILED',
      snapshotIdentifier: 'accountpulse-count-drift-test',
      failureCode: 'RESET_EXECUTION_FAILED'
    });
    expect(run?.rowCountManifest.contacts).toBe(1);
  });

  it('never overwrites a snapshot already bound to the reset run on failure', async () => {
    const seeded = await seedGraph();
    const { resetRunId } = await prepare(seeded);
    const lockedSnapshot = 'accountpulse-locked-snapshot';
    const service = createOperationalResetService({
      database: database.db,
      clock,
      afterEvidenceRecorded: async () => {
        await database.db
          .update(operationalResetRuns)
          .set({ snapshotIdentifier: lockedSnapshot })
          .where(eq(operationalResetRuns.id, resetRunId));
      }
    });

    await expect(
      service.execute({
        organisationId: seeded.organisationId,
        resetRunId,
        snapshotIdentifier: 'accountpulse-unbound-snapshot'
      })
    ).rejects.toThrow('SNAPSHOT_IDENTIFIER_MISMATCH');

    const [failedRun] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(failedRun).toMatchObject({
      status: 'FAILED',
      snapshotIdentifier: lockedSnapshot,
      failureCode: 'RESET_EXECUTION_FAILED'
    });
  });

  it('rolls back deterministically, permits same-run retry, and makes completed re-execution a no-op', async () => {
    const seeded = await seedGraph();
    const resetRunId = randomUUID();
    await prepare(seeded, resetRunId);
    const queuedJobId = await queue.enqueueUnique(
      jobNames.remindersCalculate,
      { organisationId: seeded.organisationId },
      randomUUID()
    );
    const failingService = createOperationalResetService({
      database: database.db,
      clock,
      afterDelete: ({ tableName }) => {
        if (tableName === 'outbound_messages') throw new Error('INJECTED_FAILURE');
      }
    });

    await expect(
      failingService.execute({
        organisationId: seeded.organisationId,
        resetRunId,
        snapshotIdentifier: 'accountpulse-rollback-test'
      })
    ).rejects.toThrow('INJECTED_FAILURE');
    expect(await countRows('reminder_whitelist_entries', seeded.organisationId)).toBe(1);
    expect(await countRows('outbound_messages', seeded.organisationId)).toBe(2);
    expect(await queue.findJobs(jobNames.remindersCalculate, { id: queuedJobId })).toHaveLength(1);
    const [failedOrganisation] = await database.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(failedOrganisation).toMatchObject({
      maintenanceMode: true,
      operationalState: 'RESET_FAILED',
      sendMode: 'live',
      rolloutScope: 'CONTROLLED'
    });
    const [failedRun] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(failedRun).toMatchObject({
      status: 'FAILED',
      failureCode: 'RESET_EXECUTION_FAILED',
      snapshotIdentifier: 'accountpulse-rollback-test'
    });
    expect(failedRun?.rowCountManifest).toMatchObject({
      contacts: 1,
      outbound_messages: 2
    });

    const service = createOperationalResetService({ database: database.db, clock });
    const completed = await service.execute({
      organisationId: seeded.organisationId,
      resetRunId,
      snapshotIdentifier: 'accountpulse-rollback-test'
    });
    expect(completed.rowCountManifest.contacts).toBe(1);
    await expect(
      service.prepare({
        organisationId: seeded.organisationId,
        resetRunId,
        deployedCommit: '0123456789abcdef0123456789abcdef01234567',
        adminEmail: seeded.adminEmail,
        acknowledgement: OPERATIONAL_RESET_ACKNOWLEDGEMENT,
        expectedVersion: 0
      })
    ).resolves.toBeUndefined();

    const newContactId = randomUUID();
    await database.db.insert(contacts).values({
      id: newContactId,
      organisationId: seeded.organisationId,
      xeroContactId: randomUUID(),
      name: 'Post-reset contact'
    });
    const duplicate = await service.execute({
      organisationId: seeded.organisationId,
      resetRunId,
      snapshotIdentifier: 'accountpulse-rollback-test'
    });
    expect(duplicate).toEqual(completed);
    expect(
      await database.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, newContactId))
    ).toHaveLength(1);
  });

  it('aborts an idle prepared reset only for an Admin and never opens customer scope', async () => {
    const seeded = await seedGraph();
    await database.db
      .update(organisations)
      .set({ operationalState: 'RECONCILED' })
      .where(eq(organisations.id, seeded.organisationId));
    const { service, resetRunId } = await prepare(seeded);
    await expect(
      service.abort({
        organisationId: seeded.organisationId,
        resetRunId,
        adminEmail: 'unknown@example.invalid',
        reason: 'Operator cancelled the release'
      })
    ).rejects.toThrow('ADMIN_REQUIRED');
    await expect(
      service.abort({
        organisationId: seeded.organisationId,
        resetRunId,
        adminEmail: seeded.adminEmail,
        reason: '   '
      })
    ).rejects.toThrow('ABORT_REASON_REQUIRED');

    await service.abort({
      organisationId: seeded.organisationId,
      resetRunId,
      adminEmail: seeded.adminEmail,
      reason: 'Snapshot window expired'
    });
    const [organisation] = await database.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toMatchObject({
      maintenanceMode: false,
      operationalState: 'RECONCILED',
      sendMode: 'live',
      rolloutScope: 'CONTROLLED'
    });
    const [run] = await database.db
      .select()
      .from(operationalResetRuns)
      .where(eq(operationalResetRuns.id, resetRunId));
    expect(run?.status).toBe('ABORTED');
    const events = await database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, seeded.organisationId),
          eq(auditEvents.eventType, 'PRODUCTION_OPERATIONAL_RESET_ABORTED')
        )
      );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(seeded.adminEmail);
    expect(events[0]?.afterValue?.reason).toBe('Snapshot window expired');
  });
});
