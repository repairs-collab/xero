import { and, eq, gte, inArray, isNull, lt, ne, or } from 'drizzle-orm';

import { approvals, auditEvents, conversations, type Database, inboundMessages, invoiceChases, invoices, operatorReplies, stageInstances, webhookEvents } from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';

const retained = '[RETAINED_METADATA_ONLY]';

export async function applyRetention(dependencies: { database: Database; clock: { now(): Date }; batchSize?: number }, payload: JobPayloads['retention.apply']) {
  const now = dependencies.clock.now(); const batchSize = dependencies.batchSize ?? 500;
  const contentCutoff = new Date(now); contentCutoff.setUTCMonth(contentCutoff.getUTCMonth() - 24);
  const webhookCutoff = new Date(now); webhookCutoff.setUTCDate(webhookCutoff.getUTCDate() - 90);
  const oldInvoices = await dependencies.database.select({ id: invoices.id, contactId: invoices.contactId }).from(invoices).where(and(eq(invoices.organisationId, payload.organisationId), lt(invoices.resolvedAt, contentCutoff))).limit(batchSize);
  const invoiceIds = oldInvoices.map((invoice) => invoice.id);
  let approvalsRedacted = 0;
  if (invoiceIds.length > 0) {
    const approvalRows = await dependencies.database.select({ id: approvals.id }).from(approvals).innerJoin(stageInstances, eq(stageInstances.id, approvals.stageInstanceId)).innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId)).where(and(eq(approvals.organisationId, payload.organisationId), inArray(invoiceChases.invoiceId, invoiceIds), ne(approvals.renderedPreview, retained))).limit(batchSize);
    if (approvalRows.length > 0) approvalsRedacted = (await dependencies.database.update(approvals).set({ renderedPreview: retained }).where(inArray(approvals.id, approvalRows.map((row) => row.id))).returning({ id: approvals.id })).length;
  }
  const candidateContacts = [...new Set(oldInvoices.map((invoice) => invoice.contactId))];
  const retainedContacts: string[] = [];
  for (const contactId of candidateContacts) {
    const recent = await dependencies.database.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.organisationId, payload.organisationId), eq(invoices.contactId, contactId), or(isNull(invoices.resolvedAt), gte(invoices.resolvedAt, contentCutoff)))).limit(1);
    if (recent.length === 0) retainedContacts.push(contactId);
  }
  let inboundRedacted = 0; let repliesRedacted = 0;
  if (retainedContacts.length > 0) {
    const conversationRows = await dependencies.database.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.organisationId, payload.organisationId), inArray(conversations.contactId, retainedContacts))).limit(batchSize);
    const conversationIds = conversationRows.map((row) => row.id);
    if (conversationIds.length > 0) {
      const inboundRows = await dependencies.database.select({ id: inboundMessages.id }).from(inboundMessages).where(and(eq(inboundMessages.organisationId, payload.organisationId), inArray(inboundMessages.conversationId, conversationIds), ne(inboundMessages.body, retained))).limit(batchSize);
      if (inboundRows.length > 0) inboundRedacted = (await dependencies.database.update(inboundMessages).set({ body: retained }).where(inArray(inboundMessages.id, inboundRows.map((row) => row.id))).returning({ id: inboundMessages.id })).length;
      const replyRows = await dependencies.database.select({ id: operatorReplies.id }).from(operatorReplies).where(and(eq(operatorReplies.organisationId, payload.organisationId), inArray(operatorReplies.conversationId, conversationIds), ne(operatorReplies.content, retained))).limit(batchSize);
      if (replyRows.length > 0) repliesRedacted = (await dependencies.database.update(operatorReplies).set({ content: retained, updatedAt: now }).where(inArray(operatorReplies.id, replyRows.map((row) => row.id))).returning({ id: operatorReplies.id })).length;
    }
  }
  const expiredWebhooks = await dependencies.database.select({ id: webhookEvents.id }).from(webhookEvents).where(and(eq(webhookEvents.organisationId, payload.organisationId), lt(webhookEvents.receivedAt, webhookCutoff))).limit(batchSize);
  const webhooksDeleted = expiredWebhooks.length === 0 ? 0 : (await dependencies.database.delete(webhookEvents).where(inArray(webhookEvents.id, expiredWebhooks.map((row) => row.id))).returning({ id: webhookEvents.id })).length;
  const result = { approvalsRedacted, inboundRedacted, repliesRedacted, webhooksDeleted, contentCutoff: contentCutoff.toISOString(), webhookCutoff: webhookCutoff.toISOString() };
  await dependencies.database.insert(auditEvents).values({ organisationId: payload.organisationId, eventType: 'RETENTION_APPLIED', entityType: 'ORGANISATION', entityId: payload.organisationId, afterValue: result, occurredAt: now });
  return result;
}
