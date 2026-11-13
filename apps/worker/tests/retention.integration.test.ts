import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approvals, auditEvents, contacts, conversations, createDatabase, dataRequestCases, inboundMessages, invoiceChases, invoices, messageAttempts, migrateDatabase, operatorReplies, organisations, outboundMessages, reminderSequenceVersions, reminderSequences, retentionCases, stageInstances, users, webhookEvents } from '@bc5000/db';

import { applyRetention } from '../src/handlers/retention-apply.js';
import { writeRetentionLegalHold } from '../src/services/retention-legal-hold.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T00:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const waitForBlockedRetentionCleanup = async (): Promise<void> => {
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
           and (query like '%"approvals"%' or query like '%"organisations"%')
      ) as blocked
    `);
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('retention cleanup did not reach the controlled lock');
};

describe('retention', () => {
  it('blocks a due deletion request under legal hold without crossing tenants or duplicating its audit', async () => {
    const organisationId = randomUUID();
    const otherOrganisationId = randomUUID();
    const requestId = randomUUID();
    const otherRequestId = randomUUID();
    const closureEpisodeId = randomUUID();
    for (const [id, name] of [
      [organisationId, 'Held retention tenant'],
      [otherOrganisationId, 'Other retention tenant']
    ] as const) {
      await client.db.insert(organisations).values({
        id,
        xeroOrganisationId: randomUUID(),
        name,
        timeZone: 'Australia/Sydney',
        baseCurrency: 'AUD'
      });
    }
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'LEGAL_HOLD',
      disconnectedAt: new Date('2021-08-01T00:00:00.000Z'),
      reviewAfter: new Date('2021-09-01T00:00:00.000Z'),
      closureEpisodeId,
      closureEffectiveAt: new Date('2021-08-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      backupExpiryVerifiedAt: new Date('2026-08-15T00:00:00.000Z'),
      backupExpiryEvidenceReference: 'backup-review-held-tenant',
      backupExpiryClosureEpisodeId: closureEpisodeId
    });
    await client.db.insert(dataRequestCases).values([
      {
        id: requestId,
        organisationId,
        requestType: 'DELETION',
        verificationReference: 'privacy-case-held',
        idempotencyKey: 'verified-request-held',
        verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
        targetAt: new Date('2026-08-31T00:00:00.000Z')
        ,retentionClosureEpisodeId: closureEpisodeId
      },
      {
        id: otherRequestId,
        organisationId: otherOrganisationId,
        requestType: 'DELETION',
        verificationReference: 'privacy-case-other',
        idempotencyKey: 'verified-request-other',
        verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
        targetAt: new Date('2026-08-31T00:00:00.000Z')
      }
    ]);

    await applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 100 },
      { organisationId }
    );
    await applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 100 },
      { organisationId }
    );

    expect(
      (
        await client.db
          .select()
          .from(dataRequestCases)
          .where(eq(dataRequestCases.id, requestId))
      )[0]
    ).toMatchObject({
      status: 'BLOCKED',
      blockReason: 'LEGAL_HOLD',
      version: 1
    });
    expect(
      (
        await client.db
          .select()
          .from(dataRequestCases)
          .where(eq(dataRequestCases.id, otherRequestId))
      )[0]
    ).toMatchObject({ status: 'VERIFIED', version: 0 });
    expect(
      (
        await client.db
          .select()
          .from(retentionCases)
          .where(eq(retentionCases.organisationId, organisationId))
      )[0]?.status
    ).toBe('LEGAL_HOLD');
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, organisationId),
            eq(auditEvents.eventType, 'DATA_REQUEST_REVIEW_STATE_CHANGED'),
            eq(auditEvents.entityId, requestId)
          )
        )
    ).toHaveLength(1);
  });

  it('suspends irreversible message redaction and processed-webhook deletion under legal hold', async () => {
    const organisationId = randomUUID();
    const contactId = randomUUID();
    const invoiceId = randomUUID();
    const sequenceId = randomUUID();
    const versionId = randomUUID();
    const chaseId = randomUUID();
    const stageId = randomUUID();
    const approvalId = randomUUID();
    const outboundId = randomUUID();
    const webhookId = randomUUID();
    await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Held content tenant', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
    await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Held customer' });
    await client.db.insert(invoices).values({ id: invoiceId, organisationId, xeroInvoiceId: randomUUID(), contactId, invoiceNumber: 'HOLD-1', type: 'ACCREC', status: 'PAID', issueDate: '2024-01-01', dueDate: '2024-02-01', amountDue: '0', currency: 'AUD', syncVersion: 1, resolvedAt: new Date('2024-08-01T00:00:00Z') });
    await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Held sequence' });
    await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'RETIRED' });
    await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId, sequenceId, customerId: contactId, status: 'CLOSED' });
    await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'held', channel: 'SMS', status: 'DELIVERED', scheduledAt: new Date('2024-02-01T00:00:00Z'), sourceVersion: 1 });
    await client.db.insert(approvals).values({ id: approvalId, organisationId, stageInstanceId: stageId, renderedPreview: 'Held approval content', sourceVersion: 1, status: 'APPROVED', expiresAt: new Date('2024-02-02T00:00:00Z') });
    await client.db.insert(outboundMessages).values({ id: outboundId, organisationId, stageInstanceId: stageId, contactId, invoiceId, channel: 'SMS', source: 'AUTOMATED_REMINDER', recipientKey: '+61400000009', content: 'Held outbound content', contentHash: 'held-outbound-hash', status: 'DELIVERED', idempotencyKey: randomUUID(), completedAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(webhookEvents).values({ id: webhookId, organisationId, provider: 'SINCH', providerEventKey: randomUUID(), bodyHash: 'held-webhook-hash', signatureValid: true, providerPayload: { held: true }, receivedAt: new Date('2026-01-01T00:00:00Z'), processedAt: new Date('2026-01-01T00:00:01Z') });
    await client.db.insert(retentionCases).values({ organisationId, source: 'SUBSCRIPTION_CANCELLED', status: 'LEGAL_HOLD', disconnectedAt: new Date('2021-08-01T00:00:00Z'), reviewAfter: new Date('2021-09-01T00:00:00Z'), closureEffectiveAt: new Date('2021-08-01T00:00:00Z'), deletionEligibleAt: new Date('2026-08-01T00:00:00Z') });

    const result = await applyRetention({ database: client.db, clock: { now: () => now }, batchSize: 100 }, { organisationId });

    expect(result).toMatchObject({ legalHoldActive: true, approvalsRedacted: 0, outboundRedacted: 0, webhooksDeleted: 0 });
    expect((await client.db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]?.renderedPreview).toBe('Held approval content');
    expect((await client.db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)))[0]?.content).toBe('Held outbound content');
    expect(await client.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookId))).toHaveLength(1);
  });

  it('honours a legal hold committed while cleanup is starting even when no retention row existed', async () => {
    const organisationId = randomUUID();
    const contactId = randomUUID();
    const invoiceId = randomUUID();
    const sequenceId = randomUUID();
    const versionId = randomUUID();
    const chaseId = randomUUID();
    const stageId = randomUUID();
    const approvalId = randomUUID();
    const outboundId = randomUUID();
    const webhookId = randomUUID();
    await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Concurrent legal hold tenant', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
    await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Held customer' });
    await client.db.insert(invoices).values({ id: invoiceId, organisationId, xeroInvoiceId: randomUUID(), contactId, invoiceNumber: 'HOLD-RACE-1', type: 'ACCREC', status: 'PAID', issueDate: '2024-01-01', dueDate: '2024-02-01', amountDue: '0', currency: 'AUD', syncVersion: 1, resolvedAt: new Date('2024-08-01T00:00:00Z') });
    await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Concurrent hold sequence' });
    await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'RETIRED' });
    await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId, sequenceId, customerId: contactId, status: 'CLOSED' });
    await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'held-race', channel: 'SMS', status: 'DELIVERED', scheduledAt: new Date('2024-02-01T00:00:00Z'), sourceVersion: 1 });
    await client.db.insert(approvals).values({ id: approvalId, organisationId, stageInstanceId: stageId, renderedPreview: 'Concurrent held approval', sourceVersion: 1, status: 'APPROVED', expiresAt: new Date('2024-02-02T00:00:00Z') });
    await client.db.insert(outboundMessages).values({ id: outboundId, organisationId, stageInstanceId: stageId, contactId, invoiceId, channel: 'SMS', source: 'AUTOMATED_REMINDER', recipientKey: '+61400000010', content: 'Concurrent held outbound', contentHash: 'held-race-outbound-hash', status: 'DELIVERED', idempotencyKey: randomUUID(), completedAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(webhookEvents).values({ id: webhookId, organisationId, provider: 'SINCH', providerEventKey: randomUUID(), bodyHash: 'held-race-webhook-hash', signatureValid: true, providerPayload: { held: true }, receivedAt: new Date('2026-01-01T00:00:00Z'), processedAt: new Date('2026-01-01T00:00:01Z') });

    const writerReady = deferred<void>();
    const releaseWriter = deferred<void>();
    const legalHoldWriter = client.db.transaction(async (transaction) => {
      await writeRetentionLegalHold(transaction, {
        organisationId,
        recordedAt: now,
        reason: 'Preserve records for concurrent legal review'
      });
      await transaction
        .select({ id: approvals.id })
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .for('update');
      writerReady.resolve();
      await releaseWriter.promise;
    });
    await writerReady.promise;

    const cleanup = applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 100 },
      { organisationId }
    );
    await waitForBlockedRetentionCleanup();
    releaseWriter.resolve();
    await legalHoldWriter;
    const result = await cleanup;

    expect(result).toMatchObject({
      legalHoldActive: true,
      approvalsRedacted: 0,
      outboundRedacted: 0,
      webhooksDeleted: 0
    });
    expect((await client.db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]?.renderedPreview).toBe('Concurrent held approval');
    expect((await client.db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)))[0]?.content).toBe('Concurrent held outbound');
    expect(await client.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookId))).toHaveLength(1);
  }, 10_000);

  it('keeps a due deletion request blocked until the five-year eligibility date', async () => {
    const organisationId = randomUUID();
    const requestId = randomUUID();
    const closureEpisodeId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Active retention period tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'SCHEDULED',
      disconnectedAt: new Date('2026-08-01T00:00:00.000Z'),
      reviewAfter: new Date('2026-10-01T00:00:00.000Z'),
      closureEpisodeId,
      closureEffectiveAt: new Date('2026-08-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2031-08-01T00:00:00.000Z')
    });
    await client.db.insert(dataRequestCases).values({
      id: requestId,
      organisationId,
      requestType: 'DELETION',
      verificationReference: 'privacy-case-active-period',
      idempotencyKey: 'verified-request-active-period',
      verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
      targetAt: new Date('2026-08-31T00:00:00.000Z')
      ,retentionClosureEpisodeId: closureEpisodeId
    });

    await applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 100 },
      { organisationId }
    );

    expect(
      (
        await client.db
          .select()
          .from(dataRequestCases)
          .where(eq(dataRequestCases.id, requestId))
      )[0]
    ).toMatchObject({
      status: 'BLOCKED',
      blockReason: 'RETENTION_PERIOD_ACTIVE',
      version: 1
    });
  });

  it('blocks an eligible deletion request while backup ageing is unverified', async () => {
    const organisationId = randomUUID();
    const requestId = randomUUID();
    const closureEpisodeId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Unverified backup ageing tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'REVIEW_REQUIRED',
      disconnectedAt: new Date('2021-08-01T00:00:00.000Z'),
      reviewAfter: new Date('2021-09-01T00:00:00.000Z'),
      closureEpisodeId,
      closureEffectiveAt: new Date('2021-08-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z')
    });
    await client.db.insert(dataRequestCases).values({
      id: requestId,
      organisationId,
      requestType: 'DELETION',
      verificationReference: 'privacy-case-backup-review',
      idempotencyKey: 'verified-request-backup-review',
      verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
      targetAt: new Date('2026-08-31T00:00:00.000Z')
      ,retentionClosureEpisodeId: closureEpisodeId
    });

    await applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 100 },
      { organisationId }
    );

    expect(
      (
        await client.db
          .select()
          .from(dataRequestCases)
          .where(eq(dataRequestCases.id, requestId))
      )[0]
    ).toMatchObject({
      status: 'BLOCKED',
      blockReason: 'BACKUP_AGEING_UNVERIFIED',
      version: 1
    });
  });

  it('routes an eligible deletion request to manual review after backup evidence without deleting records', async () => {
    const organisationId = randomUUID();
    const requestId = randomUUID();
    const preservedAuditId = randomUUID();
    const closureEpisodeId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Manual deletion review tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'REVIEW_REQUIRED',
      disconnectedAt: new Date('2021-08-01T00:00:00.000Z'),
      reviewAfter: new Date('2021-09-01T00:00:00.000Z'),
      closureEpisodeId,
      closureEffectiveAt: new Date('2021-08-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      backupExpiryVerifiedAt: new Date('2026-08-15T00:00:00.000Z'),
      backupExpiryEvidenceReference: 'backup-review-complete',
      backupExpiryClosureEpisodeId: closureEpisodeId
    });
    await client.db.insert(dataRequestCases).values({
      id: requestId,
      organisationId,
      requestType: 'DELETION',
      verificationReference: 'privacy-case-manual-review',
      idempotencyKey: 'verified-request-manual-review',
      verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
      targetAt: new Date('2026-08-31T00:00:00.000Z')
      ,retentionClosureEpisodeId: closureEpisodeId
    });
    await client.db.insert(auditEvents).values({
      id: preservedAuditId,
      organisationId,
      eventType: 'STATUTORY_EVIDENCE',
      entityType: 'ORGANISATION',
      entityId: organisationId,
      occurredAt: new Date('2021-08-01T00:00:00.000Z')
    });

    await applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 100 },
      { organisationId }
    );

    expect(
      (
        await client.db
          .select()
          .from(dataRequestCases)
          .where(eq(dataRequestCases.id, requestId))
      )[0]
    ).toMatchObject({
      status: 'MANUAL_REVIEW_REQUIRED',
      blockReason: null,
      version: 1
    });
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.id, preservedAuditId))
    ).toHaveLength(1);
  });

  it('moves a verified export into review at its 14-day target without treating legal hold as deletion authority', async () => {
    const organisationId = randomUUID();
    const dueRequestId = randomUUID();
    const futureRequestId = randomUUID();
    const closureEpisodeId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Export request tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'LEGAL_HOLD',
      disconnectedAt: new Date('2026-08-01T00:00:00.000Z'),
      reviewAfter: new Date('2026-09-01T00:00:00.000Z'),
      closureEpisodeId,
      closureEffectiveAt: new Date('2026-08-01T00:00:00.000Z')
    });
    await client.db.insert(dataRequestCases).values([
      {
        id: dueRequestId,
        organisationId,
        requestType: 'EXPORT',
        verificationReference: 'privacy-export-due',
        idempotencyKey: 'verified-export-due',
        verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
        targetAt: new Date('2026-08-31T00:00:00.000Z')
      },
      {
        id: futureRequestId,
        organisationId,
        requestType: 'EXPORT',
        verificationReference: 'privacy-export-future',
        idempotencyKey: 'verified-export-future',
        verifiedAt: new Date('2026-09-10T00:00:00.000Z'),
        targetAt: new Date('2026-09-24T00:00:00.000Z')
      }
    ]);

    await applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 100 },
      { organisationId }
    );

    expect(
      (
        await client.db
          .select()
          .from(dataRequestCases)
          .where(eq(dataRequestCases.id, dueRequestId))
      )[0]
    ).toMatchObject({ status: 'IN_REVIEW', version: 1 });
    expect(
      (
        await client.db
          .select()
          .from(dataRequestCases)
          .where(eq(dataRequestCases.id, futureRequestId))
      )[0]
    ).toMatchObject({ status: 'VERIFIED', version: 0 });
  });

  it('bounds due data-request review batches', async () => {
    const organisationId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Bounded request review tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(dataRequestCases).values(
      ['first', 'second'].map((suffix) => ({
        organisationId,
        requestType: 'EXPORT' as const,
        verificationReference: `privacy-export-${suffix}`,
        idempotencyKey: `verified-export-${suffix}`,
        verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
        targetAt: new Date('2026-08-31T00:00:00.000Z')
      }))
    );

    await applyRetention(
      { database: client.db, clock: { now: () => now }, batchSize: 1 },
      { organisationId }
    );

    const requests = await client.db
      .select({ status: dataRequestCases.status })
      .from(dataRequestCases)
      .where(eq(dataRequestCases.organisationId, organisationId));
    expect(requests.filter((request) => request.status === 'IN_REVIEW')).toHaveLength(1);
    expect(requests.filter((request) => request.status === 'VERIFIED')).toHaveLength(1);
  });

  it('removes message bodies after 24 months while preserving metadata and audit', async () => {
    const organisationId = randomUUID(); const contactId = randomUUID(); const invoiceId = randomUUID(); const sequenceId = randomUUID(); const versionId = randomUUID(); const chaseId = randomUUID(); const stageId = randomUUID(); const approvalId = randomUUID(); const conversationId = randomUUID(); const inboundId = randomUUID(); const replyId = randomUUID(); const userId = randomUUID(); const webhookId = randomUUID(); const unprocessedWebhookId = randomUUID(); const outboundId = randomUUID(); const attemptId = randomUUID(); const auditId = randomUUID();
    await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Retention test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
    await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Operator' });
    await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Old customer' });
    await client.db.insert(invoices).values({ id: invoiceId, organisationId, xeroInvoiceId: randomUUID(), contactId, invoiceNumber: 'OLD-1', type: 'ACCREC', status: 'PAID', issueDate: '2024-01-01', dueDate: '2024-02-01', amountDue: '0', currency: 'AUD', syncVersion: 1, resolvedAt: new Date('2024-08-01T00:00:00Z') });
    await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Old sequence' });
    await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'RETIRED' });
    await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId, sequenceId, customerId: contactId, status: 'CLOSED' });
    await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'due-date', channel: 'SMS', status: 'DELIVERED', scheduledAt: new Date('2024-02-01T00:00:00Z'), sourceVersion: 1 });
    await client.db.insert(approvals).values({ id: approvalId, organisationId, stageInstanceId: stageId, renderedPreview: 'Sensitive reminder', sourceVersion: 1, status: 'APPROVED', expiresAt: new Date('2024-02-02T00:00:00Z') });
    await client.db.insert(outboundMessages).values({ id: outboundId, organisationId, stageInstanceId: stageId, contactId, invoiceId, actorUserId: userId, channel: 'SMS', source: 'AUTOMATED_REMINDER', recipientKey: '+61400000001', content: 'Sensitive outbound', contentHash: 'outbound-hash', status: 'DELIVERED', idempotencyKey: randomUUID(), completedAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(messageAttempts).values({ id: attemptId, organisationId, outboundMessageId: outboundId, attemptNumber: 1, provider: 'SINCH', providerMessageId: randomUUID(), status: 'DELIVERED', providerPayload: { sensitive: 'raw' }, responseReceivedAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(conversations).values({ id: conversationId, organisationId, contactId, normalisedNumber: '+61400000001', lastMessageAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(inboundMessages).values({ id: inboundId, organisationId, conversationId, provider: 'SINCH', providerMessageId: randomUUID(), body: 'Sensitive inbound', bodyHash: 'inbound-hash', providerPayload: {}, receivedAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(operatorReplies).values({ id: replyId, organisationId, conversationId, actorUserId: userId, content: 'Sensitive reply', contentHash: 'reply-hash', status: 'DELIVERED', idempotencyKey: randomUUID(), sentAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(webhookEvents).values({ id: webhookId, organisationId, provider: 'SINCH', providerEventKey: randomUUID(), bodyHash: 'webhook-hash', signatureValid: true, providerPayload: { sensitive: 'raw' }, receivedAt: new Date('2026-01-01T00:00:00Z'), processedAt: new Date('2026-01-01T00:00:01Z') });
    await client.db.insert(webhookEvents).values({ id: unprocessedWebhookId, organisationId, provider: 'SINCH', providerEventKey: randomUUID(), bodyHash: 'unprocessed-webhook-hash', signatureValid: true, providerPayload: { sensitive: 'must-stay-until-processed' }, receivedAt: new Date('2026-01-01T00:00:00Z') });
    await client.db.insert(retentionCases).values({ organisationId, source: 'SUBSCRIPTION_CANCELLED', status: 'SCHEDULED', disconnectedAt: new Date('2026-07-01T00:00:00Z'), reviewAfter: new Date('2026-08-01T00:00:00Z'), closureEffectiveAt: new Date('2026-07-01T00:00:00Z') });
    await client.db.insert(auditEvents).values({ id: auditId, organisationId, eventType: 'OLD_AUDIT', entityType: 'INVOICE', entityId: invoiceId, occurredAt: new Date('2019-01-01T00:00:00Z') });

    const result = await applyRetention({ database: client.db, clock: { now: () => now }, batchSize: 100 }, { organisationId });

    expect(result).toMatchObject({ approvalsRedacted: 1, outboundRedacted: 1, attemptsRedacted: 1, inboundRedacted: 1, repliesRedacted: 1, webhooksDeleted: 1, accountReviewRequired: true });
    expect((await client.db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]?.renderedPreview).toBe('[RETAINED_METADATA_ONLY]');
    expect((await client.db.select().from(inboundMessages).where(eq(inboundMessages.id, inboundId)))[0]?.body).toBe('[RETAINED_METADATA_ONLY]');
    expect((await client.db.select().from(operatorReplies).where(eq(operatorReplies.id, replyId)))[0]?.content).toBe('[RETAINED_METADATA_ONLY]');
    expect((await client.db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)))[0]?.content).toBe('[RETAINED_METADATA_ONLY]');
    expect((await client.db.select().from(messageAttempts).where(eq(messageAttempts.id, attemptId)))[0]?.providerPayload).toEqual({ retainedMetadataOnly: true });
    expect(await client.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookId))).toHaveLength(0);
    expect(await client.db.select().from(webhookEvents).where(eq(webhookEvents.id, unprocessedWebhookId))).toHaveLength(1);
    expect((await client.db.select().from(retentionCases).where(eq(retentionCases.organisationId, organisationId)))[0]?.status).toBe('REVIEW_REQUIRED');
    expect(await client.db.select().from(auditEvents).where(eq(auditEvents.id, auditId))).toHaveLength(1);

    await applyRetention({ database: client.db, clock: { now: () => now }, batchSize: 100 }, { organisationId });
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, organisationId),
            eq(auditEvents.eventType, 'ACCOUNT_RETENTION_REVIEW_REQUIRED')
          )
        )
    ).toHaveLength(1);
  });
});
