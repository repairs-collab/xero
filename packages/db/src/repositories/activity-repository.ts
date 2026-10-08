import { and, desc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { conversations, inboundMessages, operatorReplies, outboundMessages, suppressions } from '../schema/messaging.js';
import { auditEvents, disputes, pauses, paymentPromises, tasks } from '../schema/operations.js';
import { users } from '../schema/organisation.js';
import { invoices } from '../schema/receivables.js';
import { approvals, invoiceChases, stageInstances } from '../schema/reminders.js';
import { voiceCallEvents, voiceCallInvoices, voiceCallRequests } from '../schema/voice.js';

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
  href?: string;
  actionLabel?: string;
}

const voiceEventPresentation: Readonly<Record<string, { label: string; tone: CustomerActivityRecord['tone'] }>> = {
  VOICE_CALL_STARTED: { label: 'Voice call started', tone: 'neutral' },
  VOICE_IDENTITY_CONFIRMED: { label: 'Customer identity confirmed', tone: 'positive' },
  VOICE_IDENTITY_NOT_CONFIRMED: { label: 'Customer identity not confirmed', tone: 'warning' },
  VOICE_REMINDER_DELIVERED: { label: 'Voice reminder delivered', tone: 'positive' },
  VOICE_VOICEMAIL_LEFT: { label: 'Voice reminder left by voicemail', tone: 'positive' },
  VOICE_WRONG_PERSON_REPORTED: { label: 'Wrong person reported', tone: 'warning' },
  VOICE_TRANSFER_REQUESTED: { label: 'Customer requested a transfer', tone: 'neutral' },
  VOICE_TRANSFERRED: { label: 'Customer transferred to the office', tone: 'positive' },
  VOICE_TRANSFER_UNANSWERED: { label: 'Office transfer was unanswered', tone: 'warning' },
  VOICE_NO_ANSWER: { label: 'Voice call was not answered', tone: 'neutral' },
  VOICE_BUSY: { label: 'Customer line was busy', tone: 'neutral' },
  VOICE_INVALID_DESTINATION: { label: 'Voice contact details need review', tone: 'warning' },
  VOICE_CALL_FAILED: { label: 'Voice call failed', tone: 'warning' },
  VOICE_CALL_COMPLETED: { label: 'Voice call completed', tone: 'positive' },
  VOICE_CALL_RECONCILED: { label: 'Voice call outcome reconciled', tone: 'neutral' }
};

const voiceInvoiceDetail = (invoiceNumbers: readonly string[], actorName?: string | null): string => {
  const invoiceDetail = invoiceNumbers.length === 0
    ? 'Customer account'
    : `${invoiceNumbers.length === 1 ? 'Invoice' : 'Invoices'} ${invoiceNumbers.join(', ')}`;
  return actorName ? `${invoiceDetail} · initiated by ${actorName}` : invoiceDetail;
};

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
    const voiceCallRows = await this.database
      .select({ call: voiceCallRequests, actorName: users.displayName })
      .from(voiceCallRequests)
      .leftJoin(users, eq(users.id, voiceCallRequests.actorUserId))
      .where(and(eq(voiceCallRequests.organisationId, organisationId), eq(voiceCallRequests.contactId, customerId)));
    const voiceCallIds = voiceCallRows.map((row) => row.call.id);
    const [voiceInvoiceRows, voiceEventRows, voiceSuppressionRows] = voiceCallIds.length === 0
      ? [[], [], []] as const
      : await Promise.all([
          this.database.select().from(voiceCallInvoices).where(and(eq(voiceCallInvoices.organisationId, organisationId), inArray(voiceCallInvoices.voiceCallId, voiceCallIds))),
          this.database.select().from(voiceCallEvents).where(and(eq(voiceCallEvents.organisationId, organisationId), inArray(voiceCallEvents.voiceCallId, voiceCallIds))),
          this.database.select({ normalisedDestination: suppressions.normalisedDestination, consentState: suppressions.consentState, recordedAt: suppressions.recordedAt, id: suppressions.id }).from(suppressions).where(and(eq(suppressions.organisationId, organisationId), eq(suppressions.channel, 'VOICE')))
        ]);
    const invoicesByCall = new Map<string, string[]>();
    for (const row of voiceInvoiceRows) {
      const values = invoicesByCall.get(row.voiceCallId) ?? [];
      values.push(row.invoiceNumber);
      invoicesByCall.set(row.voiceCallId, values);
    }
    const callsById = new Map(voiceCallRows.map((row) => [row.call.id, row]));
    const events: CustomerActivityRecord[] = [];
    for (const invoice of invoiceRows) events.push({ id: `invoice:${invoice.id}`, occurredAt: invoice.updatedAt, label: 'Xero invoice updated', source: 'Xero', detail: `${invoice.invoiceNumber} · ${invoice.status} · ${invoice.currency} ${invoice.amountDue}`, tone: invoice.status === 'PAID' ? 'positive' : 'neutral' });
    for (const row of approvalRows) events.push({ id: `approval:${row.approval.id}`, occurredAt: row.approval.decidedAt ?? row.approval.createdAt, label: `Reminder ${row.approval.status.toLowerCase()}`, source: 'AccountPulse', detail: `${row.invoiceNumber} · source version ${row.approval.sourceVersion}`, tone: row.approval.status === 'EXPIRED' || row.approval.status === 'REJECTED' ? 'warning' : 'neutral' });
    for (const row of outboundRows) events.push({ id: `outbound:${row.message.id}`, occurredAt: row.message.completedAt ?? row.message.updatedAt, label: `${row.message.channel === 'SMS' ? 'SMS' : 'Xero email'} ${row.message.status.toLowerCase()}`, source: row.message.channel === 'SMS' ? 'Sinch' : 'Xero', detail: row.invoiceNumber, tone: row.message.status === 'DELIVERED' || row.message.status === 'ACCEPTED' ? 'positive' : row.message.status === 'FAILED' || row.message.status === 'UNKNOWN' ? 'warning' : 'neutral' });
    for (const row of inboundRows) events.push({ id: `inbound:${row.message.id}`, occurredAt: row.message.receivedAt, label: 'Customer replied', source: 'Sinch', detail: row.message.body, tone: 'neutral' });
    for (const row of replyRows) events.push({ id: `reply:${row.reply.id}`, occurredAt: row.reply.sentAt ?? row.reply.createdAt, label: 'Operator replied', source: 'AccountPulse via Sinch', detail: row.reply.content, tone: row.reply.status === 'FAILED' ? 'warning' : 'neutral' });
    for (const pause of pauseRows) events.push({ id: `pause:${pause.id}`, occurredAt: pause.endedAt ?? pause.startedAt, label: pause.active ? 'Chasing paused' : 'Chasing resumed', source: 'AccountPulse', detail: pause.reason ?? pause.kind, tone: pause.active ? 'warning' : 'positive' });
    for (const dispute of disputeRows) events.push({ id: `dispute:${dispute.id}`, occurredAt: dispute.resolvedAt ?? dispute.recordedAt, label: `Dispute ${dispute.status.toLowerCase()}`, source: 'Operator', detail: dispute.reason, tone: dispute.status === 'OPEN' ? 'warning' : 'neutral' });
    for (const promise of promiseRows) events.push({ id: `promise:${promise.id}`, occurredAt: promise.endedAt ?? promise.recordedAt, label: 'Promise to pay', source: 'Operator', detail: `${promise.status} · promised ${promise.promisedDate} + ${promise.graceDays} grace days`, tone: promise.status === 'MISSED' ? 'warning' : 'neutral' });
    for (const task of taskRows) {
      const isVoiceReview = task.kind === 'VOICE_CONTACT_REVIEW' || task.kind === 'VOICE_OUTCOME_REVIEW';
      events.push({
        id: `task:${task.id}`,
        occurredAt: task.completedAt ?? task.createdAt,
        label: isVoiceReview ? (task.kind === 'VOICE_CONTACT_REVIEW' ? 'Voice contact details need review' : 'Voice outcome needs review') : `Escalation ${task.status.toLowerCase()}`,
        source: isVoiceReview ? 'AccountPulse Voice' : 'AccountPulse',
        detail: task.resolutionNote ?? task.summary,
        tone: task.status === 'OPEN' ? 'warning' : 'neutral',
        ...(isVoiceReview && task.status === 'OPEN' ? { href: '/escalations', actionLabel: 'Review escalation' } : {})
      });
    }
    for (const audit of auditRows) events.push({ id: `audit:${audit.id}`, occurredAt: audit.occurredAt, label: audit.eventType === 'CUSTOMER_NOTE_ADDED' ? 'Customer note' : audit.eventType.replaceAll('_', ' ').toLowerCase(), source: 'Operator', detail: typeof audit.afterValue?.note === 'string' ? audit.afterValue.note : typeof audit.afterValue?.reason === 'string' ? audit.afterValue.reason : 'Recorded in the audit trail', tone: 'neutral' });
    for (const row of voiceCallRows) {
      const invoiceNumbers = [...(invoicesByCall.get(row.call.id) ?? [])].sort();
      const detail = voiceInvoiceDetail(invoiceNumbers, row.actorName);
      if (row.call.approvedAt) events.push({ id: `voice:${row.call.id}:approved`, occurredAt: row.call.approvedAt, label: 'Voice call facts approved', source: 'AccountPulse Voice', detail, tone: 'neutral' });
      if (row.call.queuedAt) events.push({ id: `voice:${row.call.id}:queued`, occurredAt: row.call.queuedAt, label: 'Voice call queued', source: 'AccountPulse Voice', detail, tone: 'neutral' });
      if (row.call.providerAcceptedAt) events.push({ id: `voice:${row.call.id}:accepted`, occurredAt: row.call.providerAcceptedAt, label: 'Voice provider accepted the call', source: 'AccountPulse Voice', detail, tone: 'neutral' });
      if (row.call.state === 'UNKNOWN') events.push({ id: `voice:${row.call.id}:unknown`, occurredAt: row.call.updatedAt, label: 'Voice call outcome needs review', source: 'AccountPulse Voice', detail: `${detail} · outcome could not be confirmed safely`, tone: 'warning', href: '/escalations', actionLabel: 'Review escalation' });
      if (row.call.state === 'FAILED' && !voiceEventRows.some((event) => event.voiceCallId === row.call.id && event.eventType === 'VOICE_CALL_FAILED')) events.push({ id: `voice:${row.call.id}:failed`, occurredAt: row.call.completedAt ?? row.call.updatedAt, label: 'Voice call failed', source: 'AccountPulse Voice', detail, tone: 'warning' });
    }
    for (const event of voiceEventRows) {
      const presentation = voiceEventPresentation[event.eventType];
      if (!presentation) continue;
      const call = callsById.get(event.voiceCallId);
      events.push({
        id: `voice-event:${event.id}`,
        occurredAt: event.occurredAt,
        label: presentation.label,
        source: 'AccountPulse Voice',
        detail: voiceInvoiceDetail([...(invoicesByCall.get(event.voiceCallId) ?? [])].sort(), call?.actorName),
        tone: presentation.tone,
        ...(event.eventType === 'VOICE_WRONG_PERSON_REPORTED' || event.eventType === 'VOICE_INVALID_DESTINATION' ? { href: '/escalations', actionLabel: 'Review escalation' } : {})
      });
    }
    const suppressedDestinations = new Map(voiceSuppressionRows.filter((row) => row.consentState === 'SUPPRESSED').map((row) => [row.normalisedDestination, row]));
    for (const row of voiceCallRows) {
      const suppression = suppressedDestinations.get(row.call.destinationNumber);
      if (!suppression) continue;
      events.push({ id: `voice-suppression:${suppression.id}:${row.call.id}`, occurredAt: suppression.recordedAt, label: 'Voice reminders suppressed', source: 'AccountPulse Voice', detail: voiceInvoiceDetail([...(invoicesByCall.get(row.call.id) ?? [])].sort()), tone: 'warning', href: '/escalations', actionLabel: 'Review escalation' });
    }
    return events.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id));
  }
}
