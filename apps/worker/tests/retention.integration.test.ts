import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approvals, auditEvents, contacts, conversations, createDatabase, inboundMessages, invoiceChases, invoices, migrateDatabase, operatorReplies, organisations, reminderSequenceVersions, reminderSequences, stageInstances, users, webhookEvents } from '@bc5000/db';

import { applyRetention } from '../src/handlers/retention-apply.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T00:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('retention', () => {
  it('removes message bodies after 24 months while preserving metadata and audit', async () => {
    const organisationId = randomUUID(); const contactId = randomUUID(); const invoiceId = randomUUID(); const sequenceId = randomUUID(); const versionId = randomUUID(); const chaseId = randomUUID(); const stageId = randomUUID(); const approvalId = randomUUID(); const conversationId = randomUUID(); const inboundId = randomUUID(); const replyId = randomUUID(); const userId = randomUUID(); const webhookId = randomUUID(); const auditId = randomUUID();
    await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Retention test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
    await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Operator' });
    await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Old customer' });
    await client.db.insert(invoices).values({ id: invoiceId, organisationId, xeroInvoiceId: randomUUID(), contactId, invoiceNumber: 'OLD-1', type: 'ACCREC', status: 'PAID', issueDate: '2024-01-01', dueDate: '2024-02-01', amountDue: '0', currency: 'AUD', syncVersion: 1, resolvedAt: new Date('2024-08-01T00:00:00Z') });
    await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Old sequence' });
    await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'RETIRED' });
    await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId, sequenceId, customerId: contactId, status: 'CLOSED' });
    await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'due-date', channel: 'SMS', status: 'DELIVERED', scheduledAt: new Date('2024-02-01T00:00:00Z'), sourceVersion: 1 });
    await client.db.insert(approvals).values({ id: approvalId, organisationId, stageInstanceId: stageId, renderedPreview: 'Sensitive reminder', sourceVersion: 1, status: 'APPROVED', expiresAt: new Date('2024-02-02T00:00:00Z') });
    await client.db.insert(conversations).values({ id: conversationId, organisationId, contactId, normalisedNumber: '+61400000001', lastMessageAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(inboundMessages).values({ id: inboundId, organisationId, conversationId, provider: 'SINCH', providerMessageId: randomUUID(), body: 'Sensitive inbound', bodyHash: 'inbound-hash', providerPayload: {}, receivedAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(operatorReplies).values({ id: replyId, organisationId, conversationId, actorUserId: userId, content: 'Sensitive reply', contentHash: 'reply-hash', status: 'DELIVERED', idempotencyKey: randomUUID(), sentAt: new Date('2024-03-01T00:00:00Z') });
    await client.db.insert(webhookEvents).values({ id: webhookId, organisationId, provider: 'SINCH', providerEventKey: randomUUID(), bodyHash: 'webhook-hash', signatureValid: true, providerPayload: { sensitive: 'raw' }, receivedAt: new Date('2026-01-01T00:00:00Z'), processedAt: new Date('2026-01-01T00:00:01Z') });
    await client.db.insert(auditEvents).values({ id: auditId, organisationId, eventType: 'OLD_AUDIT', entityType: 'INVOICE', entityId: invoiceId, occurredAt: new Date('2019-01-01T00:00:00Z') });

    const result = await applyRetention({ database: client.db, clock: { now: () => now }, batchSize: 100 }, { organisationId });

    expect(result).toMatchObject({ approvalsRedacted: 1, inboundRedacted: 1, repliesRedacted: 1, webhooksDeleted: 1 });
    expect((await client.db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]?.renderedPreview).toBe('[RETAINED_METADATA_ONLY]');
    expect((await client.db.select().from(inboundMessages).where(eq(inboundMessages.id, inboundId)))[0]?.body).toBe('[RETAINED_METADATA_ONLY]');
    expect((await client.db.select().from(operatorReplies).where(eq(operatorReplies.id, replyId)))[0]?.content).toBe('[RETAINED_METADATA_ONLY]');
    expect(await client.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookId))).toHaveLength(0);
    expect(await client.db.select().from(auditEvents).where(eq(auditEvents.id, auditId))).toHaveLength(1);
  });
});
