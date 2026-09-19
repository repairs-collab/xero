import { and, desc, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { conversations, inboundMessages, operatorReplies, outboundMessages } from '../schema/messaging.js';
import { auditEvents, disputes, pauses, paymentPromises, tasks } from '../schema/operations.js';
import { invoices } from '../schema/receivables.js';
import { approvals, invoiceChases, stageInstances } from '../schema/reminders.js';

export interface ActivityFilters {
  query?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
}

export interface CustomerActivityRecord {
  id: string;
  occurredAt: Date;
  label: string;
  source: string;
  detail: string;
  tone: 'neutral' | 'positive' | 'warning';
}

export class PostgresActivityRepository {
  constructor(private readonly database: Database) {}

  search(organisationId: string, filters: ActivityFilters = {}) {
    const conditions: SQL[] = [eq(auditEvents.organisationId, organisationId)];
    if (filters.eventType) conditions.push(eq(auditEvents.eventType, filters.eventType));
    if (filters.from) conditions.push(gte(auditEvents.occurredAt, filters.from));
    if (filters.to) conditions.push(lte(auditEvents.occurredAt, filters.to));
    if (filters.query) {
      const pattern = `%${filters.query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      conditions.push(or(ilike(auditEvents.entityId, pattern), ilike(auditEvents.eventType, pattern), ilike(auditEvents.correlationId, pattern))!);
    }
    return this.database.select().from(auditEvents).where(and(...conditions)).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(250);
  }

  async customerTimeline(organisationId: string, customerId: string): Promise<CustomerActivityRecord[]> {
    const [invoiceRows, approvalRows, outboundRows, inboundRows, replyRows, pauseRows, disputeRows, promiseRows, taskRows, auditRows] = await Promise.all([
      this.database.select().from(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.contactId, customerId))),
      this.database.select({ approval: approvals, invoiceNumber: invoices.invoiceNumber }).from(approvals).innerJoin(stageInstances, eq(stageInstances.id, approvals.stageInstanceId)).innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId)).innerJoin(invoices, eq(invoices.id, invoiceChases.invoiceId)).where(and(eq(approvals.organisationId, organisationId), eq(invoices.contactId, customerId))),
      this.database.select({ message: outboundMessages, invoiceNumber: invoices.invoiceNumber }).from(outboundMessages).innerJoin(stageInstances, eq(stageInstances.id, outboundMessages.stageInstanceId)).innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId)).innerJoin(invoices, eq(invoices.id, invoiceChases.invoiceId)).where(and(eq(outboundMessages.organisationId, organisationId), eq(invoices.contactId, customerId))),
      this.database.select({ message: inboundMessages }).from(inboundMessages).innerJoin(conversations, eq(conversations.id, inboundMessages.conversationId)).where(and(eq(inboundMessages.organisationId, organisationId), eq(conversations.contactId, customerId))),
      this.database.select({ reply: operatorReplies }).from(operatorReplies).innerJoin(conversations, eq(conversations.id, operatorReplies.conversationId)).where(and(eq(operatorReplies.organisationId, organisationId), eq(conversations.contactId, customerId))),
      this.database.select().from(pauses).where(and(eq(pauses.organisationId, organisationId), eq(pauses.contactId, customerId))),
      this.database.select().from(disputes).where(and(eq(disputes.organisationId, organisationId), eq(disputes.contactId, customerId))),
      this.database.select().from(paymentPromises).where(and(eq(paymentPromises.organisationId, organisationId), eq(paymentPromises.contactId, customerId))),
      this.database.select().from(tasks).where(and(eq(tasks.organisationId, organisationId), eq(tasks.contactId, customerId))),
      this.database.select().from(auditEvents).where(and(eq(auditEvents.organisationId, organisationId), eq(auditEvents.entityType, 'CONTACT'), eq(auditEvents.entityId, customerId)))
    ]);
    const events: CustomerActivityRecord[] = [];
    for (const invoice of invoiceRows) events.push({ id: `invoice:${invoice.id}`, occurredAt: invoice.updatedAt, label: 'Xero invoice updated', source: 'Xero', detail: `${invoice.invoiceNumber} · ${invoice.status} · ${invoice.currency} ${invoice.amountDue}`, tone: invoice.status === 'PAID' ? 'positive' : 'neutral' });
    for (const row of approvalRows) events.push({ id: `approval:${row.approval.id}`, occurredAt: row.approval.decidedAt ?? row.approval.createdAt, label: `Reminder ${row.approval.status.toLowerCase()}`, source: 'Bill Chaser', detail: `${row.invoiceNumber} · source version ${row.approval.sourceVersion}`, tone: row.approval.status === 'EXPIRED' || row.approval.status === 'REJECTED' ? 'warning' : 'neutral' });
    for (const row of outboundRows) events.push({ id: `outbound:${row.message.id}`, occurredAt: row.message.completedAt ?? row.message.updatedAt, label: `${row.message.channel === 'SMS' ? 'SMS' : 'Xero email'} ${row.message.status.toLowerCase()}`, source: row.message.channel === 'SMS' ? 'Sinch' : 'Xero', detail: row.invoiceNumber, tone: row.message.status === 'DELIVERED' || row.message.status === 'ACCEPTED' ? 'positive' : row.message.status === 'FAILED' || row.message.status === 'UNKNOWN' ? 'warning' : 'neutral' });
    for (const row of inboundRows) events.push({ id: `inbound:${row.message.id}`, occurredAt: row.message.receivedAt, label: 'Customer replied', source: 'Sinch', detail: row.message.body, tone: 'neutral' });
    for (const row of replyRows) events.push({ id: `reply:${row.reply.id}`, occurredAt: row.reply.sentAt ?? row.reply.createdAt, label: 'Operator replied', source: 'Bill Chaser via Sinch', detail: row.reply.content, tone: row.reply.status === 'FAILED' ? 'warning' : 'neutral' });
    for (const pause of pauseRows) events.push({ id: `pause:${pause.id}`, occurredAt: pause.endedAt ?? pause.startedAt, label: pause.active ? 'Chasing paused' : 'Chasing resumed', source: 'Bill Chaser', detail: pause.reason ?? pause.kind, tone: pause.active ? 'warning' : 'positive' });
    for (const dispute of disputeRows) events.push({ id: `dispute:${dispute.id}`, occurredAt: dispute.resolvedAt ?? dispute.recordedAt, label: `Dispute ${dispute.status.toLowerCase()}`, source: 'Operator', detail: dispute.reason, tone: dispute.status === 'OPEN' ? 'warning' : 'neutral' });
    for (const promise of promiseRows) events.push({ id: `promise:${promise.id}`, occurredAt: promise.endedAt ?? promise.recordedAt, label: 'Promise to pay', source: 'Operator', detail: `${promise.status} · promised ${promise.promisedDate} + ${promise.graceDays} grace days`, tone: promise.status === 'MISSED' ? 'warning' : 'neutral' });
    for (const task of taskRows) events.push({ id: `task:${task.id}`, occurredAt: task.completedAt ?? task.createdAt, label: `Escalation ${task.status.toLowerCase()}`, source: 'Bill Chaser', detail: task.resolutionNote ?? task.summary, tone: task.status === 'OPEN' ? 'warning' : 'neutral' });
    for (const audit of auditRows) events.push({ id: `audit:${audit.id}`, occurredAt: audit.occurredAt, label: audit.eventType === 'CUSTOMER_NOTE_ADDED' ? 'Customer note' : audit.eventType.replaceAll('_', ' ').toLowerCase(), source: 'Operator', detail: typeof audit.afterValue?.note === 'string' ? audit.afterValue.note : typeof audit.afterValue?.reason === 'string' ? audit.afterValue.reason : 'Recorded in the audit trail', tone: 'neutral' });
    return events.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id));
  }
}
