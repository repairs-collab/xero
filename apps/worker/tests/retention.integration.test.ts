import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approvals, auditEvents, contacts, conversations, createDatabase, dataRequestCases, inboundMessages, invoiceChases, invoices, messageAttempts, migrateDatabase, operatorReplies, organisations, outboundMessages, reminderSequenceVersions, reminderSequences, retentionCases, stageInstances, users, webhookEvents } from '@bc5000/db';

import { applyRetention } from '../src/handlers/retention-apply.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T00:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('retention', () => {
  it('blocks a due deletion request under legal hold without crossing tenants or duplicating its audit', async () => {
    const organisationId = randomUUID();
    const otherOrganisationId = randomUUID();
    const requestId = randomUUID();
    const otherRequestId = randomUUID();
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
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      backupExpiryVerifiedAt: new Date('2026-08-15T00:00:00.000Z'),
      backupExpiryEvidenceReference: 'backup-review-held-tenant'
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

  it('keeps a due deletion request blocked until the five-year eligibility date', async () => {
    const organisationId = randomUUID();
    const requestId = randomUUID();
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
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      backupExpiryVerifiedAt: new Date('2026-08-15T00:00:00.000Z'),
      backupExpiryEvidenceReference: 'backup-review-complete'
    });
    await client.db.insert(dataRequestCases).values({
      id: requestId,
      organisationId,
      requestType: 'DELETION',
      verificationReference: 'privacy-case-manual-review',
      idempotencyKey: 'verified-request-manual-review',
      verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
      targetAt: new Date('2026-08-31T00:00:00.000Z')
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
      reviewAfter: new Date('2026-09-01T00:00:00.000Z')
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
    await client.db.insert(retentionCases).values({ organisationId, source: 'SUBSCRIPTION_CANCELLED', status: 'SCHEDULED', disconnectedAt: new Date('2026-07-01T00:00:00Z'), reviewAfter: new Date('2026-08-01T00:00:00Z') });
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
