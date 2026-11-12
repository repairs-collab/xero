import { and, desc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { conversations, inboundMessages, operatorReplies, outboundMessages, suppressions } from '../schema/messaging.js';
import { auditEvents, disputes, pauses, paymentPromises, tasks } from '../schema/operations.js';
import { users } from '../schema/organisation.js';
import { invoices } from '../schema/receivables.js';
import { approvals, invoiceChases, reminderSequences, stageInstances } from '../schema/reminders.js';
import { voiceCallEvents, voiceCallInvoices, voiceCallRequests } from '../schema/voice.js';

export interface ActivityFilters {
  query?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
}

export const CUSTOMER_ACTIVITY_FILTER_OPTIONS = [
  { value: 'account', label: 'Account' },
  { value: 'customers', label: 'Customers' },
  { value: 'messaging', label: 'Messages and reminders' },
  { value: 'sequences', label: 'Sequences' },
  { value: 'users', label: 'Users' },
  { value: 'voice', label: 'Voice reminders' },
  { value: 'xero', label: 'Xero' }
] as const;

export type CustomerActivityType =
  (typeof CUSTOMER_ACTIVITY_FILTER_OPTIONS)[number]['value'];

export interface CustomerActivityFilters {
  query?: string;
  activityType?: CustomerActivityType;
  from?: Date;
  to?: Date;
}

export interface CustomerAuditActivityRecord {
  id: string;
  occurredAt: Date;
  label: string;
  subject: string;
  actorLabel: 'User action' | 'System activity';
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
  links?: Array<{ href: string; label: string }>;
}

type VoiceCallSource = 'MANUAL' | 'SEQUENCE_REVIEW' | 'SEQUENCE_AUTOMATIC';
type VoiceInvoiceReference = { invoiceId: string; invoiceNumber: string };

type CustomerAuditPresentation = {
  label: string;
  subject: string;
  activityType: CustomerActivityType;
};

const customerAuditPresentation = {
  ADMIN_MOBILE_VERIFICATION_REQUESTED: { label: 'Mobile verification requested', subject: 'Account security', activityType: 'account' },
  ADMIN_MOBILE_VERIFIED: { label: 'Mobile number verified', subject: 'Account security', activityType: 'account' },
  ALL_PROVIDER_SENDING_DISABLED: { label: 'Message sending paused', subject: 'Sending controls', activityType: 'messaging' },
  APPROVAL_EXPIRED_STALE: { label: 'Reminder approval expired', subject: 'Reminder', activityType: 'messaging' },
  CALL_LINK_OPENED: { label: 'Customer call opened', subject: 'Customer', activityType: 'customers' },
  CUSTOMER_CHASING_PAUSED: { label: 'Customer reminders paused', subject: 'Customer', activityType: 'customers' },
  CUSTOMER_CHASING_RESUMED: { label: 'Customer reminders resumed', subject: 'Customer', activityType: 'customers' },
  CUSTOMER_NOTE_ADDED: { label: 'Customer note added', subject: 'Customer', activityType: 'customers' },
  CUSTOMER_PHONE_OVERRIDE_CLEARED: { label: 'Customer phone override cleared', subject: 'Customer', activityType: 'customers' },
  CUSTOMER_PHONE_OVERRIDE_SET: { label: 'Customer phone updated', subject: 'Customer', activityType: 'customers' },
  CUSTOMER_ROLLOUT_ACTIVATED: { label: 'Live customer messaging enabled', subject: 'Sending controls', activityType: 'messaging' },
  CUSTOMER_ROLLOUT_RETURNED_TO_CONTROLLED: { label: 'Customer messaging returned to review', subject: 'Sending controls', activityType: 'messaging' },
  CUSTOMER_ROLLOUT_SETUP_OVERRIDE_ACTIVATED: { label: 'Customer messaging setup confirmed', subject: 'Sending controls', activityType: 'messaging' },
  DISPUTE_RECORDED: { label: 'Dispute recorded', subject: 'Customer', activityType: 'customers' },
  ESCALATION_TASK_COMPLETED: { label: 'Escalation completed', subject: 'Customer', activityType: 'customers' },
  INITIAL_ADMIN_BOOTSTRAPPED: { label: 'Initial administrator created', subject: 'Account', activityType: 'account' },
  LIVE_SENDING_ACTIVATED: { label: 'Live sending enabled', subject: 'Sending controls', activityType: 'messaging' },
  ONBOARDING_ATTESTATION_RECORDED: { label: 'Onboarding acceptance recorded', subject: 'Account', activityType: 'account' },
  ONBOARDING_COMPLETED: { label: 'Onboarding completed', subject: 'Account', activityType: 'account' },
  OPERATOR_REPLY_ACCEPTED: { label: 'Reply accepted for delivery', subject: 'Customer message', activityType: 'messaging' },
  OPERATOR_REPLY_QUEUED: { label: 'Reply queued', subject: 'Customer message', activityType: 'messaging' },
  PAYMENT_PROMISE_RECORDED: { label: 'Payment promise recorded', subject: 'Customer', activityType: 'customers' },
  REMINDER_APPROVED: { label: 'Reminder approved', subject: 'Reminder', activityType: 'messaging' },
  REMINDER_REJECTED: { label: 'Reminder rejected', subject: 'Reminder', activityType: 'messaging' },
  REMINDER_SNOOZED: { label: 'Reminder snoozed', subject: 'Reminder', activityType: 'messaging' },
  REMINDER_WHITELIST_ADDED: { label: 'Reminder exclusion added', subject: 'Reminder exclusions', activityType: 'sequences' },
  REMINDER_WHITELIST_REMOVED: { label: 'Reminder exclusion removed', subject: 'Reminder exclusions', activityType: 'sequences' },
  REMINDERS_CANCELLED_BY_WHITELIST: { label: 'Excluded reminders cancelled', subject: 'Reminder exclusions', activityType: 'sequences' },
  ROLLOUT_RECONCILIATION_ACKNOWLEDGED: { label: 'Xero reconciliation confirmed', subject: 'Sending controls', activityType: 'xero' },
  SEND_ALLOWLIST_UPDATED: { label: 'Test recipient list updated', subject: 'Sending controls', activityType: 'messaging' },
  SEQUENCE_ENABLED_CHANGED: { label: 'Sequence availability changed', subject: 'Sequence', activityType: 'sequences' },
  SEQUENCE_MODE_CHANGED: { label: 'Sequence mode changed', subject: 'Sequence', activityType: 'sequences' },
  SMS_OPT_OUT: { label: 'Customer opted out of SMS', subject: 'Customer message', activityType: 'messaging' },
  TEST_SMS_QUEUED: { label: 'Test message queued', subject: 'Test sending', activityType: 'messaging' },
  USER_DISABLED: { label: 'User disabled', subject: 'User access', activityType: 'users' },
  USER_INVITATION_RESENT: { label: 'User invitation resent', subject: 'User access', activityType: 'users' },
  USER_INVITED: { label: 'User invited', subject: 'User access', activityType: 'users' },
  USER_ROLE_CHANGED: { label: 'User role changed', subject: 'User access', activityType: 'users' },
  VOICE_CALL_FACTS_APPROVED: { label: 'Voice call details approved', subject: 'Voice reminder', activityType: 'voice' },
  VOICE_CALL_RECONCILED: { label: 'Voice call outcome reconciled', subject: 'Voice reminder', activityType: 'voice' },
  VOICE_CONNECTION_TESTED: { label: 'Voice connection tested', subject: 'Voice settings', activityType: 'voice' },
  VOICE_GENERIC_FLOW_TESTED: { label: 'Voice call flow tested', subject: 'Voice settings', activityType: 'voice' },
  VOICE_REMINDER_APPROVED: { label: 'Voice reminder approved', subject: 'Voice reminder', activityType: 'voice' },
  VOICE_REMINDER_QUEUED: { label: 'Voice reminder queued', subject: 'Voice reminder', activityType: 'voice' },
  VOICE_REMINDER_REJECTED: { label: 'Voice reminder rejected', subject: 'Voice reminder', activityType: 'voice' },
  VOICE_SETTINGS_CHANGED: { label: 'Voice settings changed', subject: 'Voice settings', activityType: 'voice' },
  VOICE_TEST_CALL_FACTS_APPROVED: { label: 'Voice test details approved', subject: 'Voice settings', activityType: 'voice' },
  XERO_DISCONNECTED: { label: 'Xero disconnected', subject: 'Xero connection', activityType: 'xero' },
  XERO_RECONCILIATION_COMPLETED: { label: 'Xero reconciliation completed', subject: 'Xero sync', activityType: 'xero' },
  XERO_SYNC_QUEUE_FAILED: { label: 'Xero sync could not be queued', subject: 'Xero sync', activityType: 'xero' },
  XERO_SYNC_QUEUED: { label: 'Xero sync queued', subject: 'Xero sync', activityType: 'xero' },
  XERO_SYNC_REQUESTED: { label: 'Xero sync requested', subject: 'Xero sync', activityType: 'xero' },
  XERO_TENANT_CONFLICT_REJECTED: { label: 'Xero organisation selection rejected', subject: 'Xero connection', activityType: 'xero' },
  XERO_TENANT_SELECTED: { label: 'Xero organisation selected', subject: 'Xero connection', activityType: 'xero' }
} as const satisfies Readonly<Record<string, CustomerAuditPresentation>>;

const customerAuditEventTypes = Object.keys(customerAuditPresentation);

export const isCustomerActivityType = (
  value: string | undefined
): value is CustomerActivityType => CUSTOMER_ACTIVITY_FILTER_OPTIONS.some(
  (option) => option.value === value
);

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

const voiceCallLabel = (
  label: string,
  purpose: 'CUSTOMER' | 'TEST' | undefined
): string => (purpose === 'TEST' ? `TEST - ${label}` : label);

const voiceCallSource = (
  purpose: 'CUSTOMER' | 'TEST' | undefined,
  source: VoiceCallSource | undefined
): string => {
  if (purpose === 'TEST') return 'AccountPulse Voice - TEST';
  if (source === 'SEQUENCE_REVIEW') return 'AccountPulse Voice - Sequence review';
  if (source === 'SEQUENCE_AUTOMATIC') return 'AccountPulse Voice - Sequence automatic';
  return 'AccountPulse Voice - Manual';
};

const voiceCallDetail = (
  invoiceNumbers: readonly string[],
  purpose: 'CUSTOMER' | 'TEST' | undefined,
  actorName?: string | null,
  source?: VoiceCallSource,
  sequenceName?: string | null,
  stageKey?: string | null
): string => {
  const invoiceDetail = voiceInvoiceDetail(invoiceNumbers, actorName);
  const detail = source === 'SEQUENCE_REVIEW' || source === 'SEQUENCE_AUTOMATIC'
    ? `${invoiceDetail} · ${sequenceName ?? 'Voice sequence'} - stage ${stageKey ?? 'unknown'}`
    : invoiceDetail;
  return purpose === 'TEST' ? `TEST - ${detail}` : detail;
};

const voiceInvoiceLinks = (
  invoiceReferences: readonly VoiceInvoiceReference[]
): Array<{ href: string; label: string }> => invoiceReferences.map((invoice) => ({
  href: `/invoices/${invoice.invoiceId}`,
  label: invoice.invoiceNumber
}));

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

  async searchCustomerActivity(
    organisationId: string,
    filters: CustomerActivityFilters = {}
  ): Promise<CustomerAuditActivityRecord[]> {
    const conditions: SQL[] = [
      eq(auditEvents.organisationId, organisationId),
      inArray(auditEvents.eventType, customerAuditEventTypes)
    ];
    if (filters.activityType) {
      if (!isCustomerActivityType(filters.activityType)) return [];
      conditions.push(inArray(
        auditEvents.eventType,
        customerAuditEventTypes.filter(
          (eventType) => customerAuditPresentation[eventType as keyof typeof customerAuditPresentation].activityType === filters.activityType
        )
      ));
    }
    if (filters.from) conditions.push(gte(auditEvents.occurredAt, filters.from));
    if (filters.to) conditions.push(lte(auditEvents.occurredAt, filters.to));
    if (filters.query) {
      const pattern = `%${filters.query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      conditions.push(or(
        ilike(auditEvents.entityId, pattern),
        ilike(auditEvents.eventType, pattern),
        ilike(auditEvents.correlationId, pattern)
      )!);
    }
    const rows = await this.database
      .select({
        id: auditEvents.id,
        occurredAt: auditEvents.occurredAt,
        eventType: auditEvents.eventType,
        actorUserId: auditEvents.actorUserId
      })
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(250);

    return rows.flatMap((row) => {
      const presentation = customerAuditPresentation[
        row.eventType as keyof typeof customerAuditPresentation
      ];
      if (!presentation) return [];
      return [{
        id: row.id,
        occurredAt: row.occurredAt,
        label: presentation.label,
        subject: presentation.subject,
        actorLabel: row.actorUserId ? 'User action' as const : 'System activity' as const
      }];
    });
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
      .select({ call: voiceCallRequests, actorName: users.displayName, sequenceName: reminderSequences.name })
      .from(voiceCallRequests)
      .leftJoin(users, eq(users.id, voiceCallRequests.actorUserId))
      .leftJoin(reminderSequences, eq(reminderSequences.id, voiceCallRequests.sequenceId))
      .where(and(eq(voiceCallRequests.organisationId, organisationId), eq(voiceCallRequests.contactId, customerId)));
    const voiceCallIds = voiceCallRows.map((row) => row.call.id);
    const [voiceInvoiceRows, voiceEventRows, voiceSuppressionRows] = voiceCallIds.length === 0
      ? [[], [], []] as const
      : await Promise.all([
          this.database.select().from(voiceCallInvoices).where(and(eq(voiceCallInvoices.organisationId, organisationId), inArray(voiceCallInvoices.voiceCallId, voiceCallIds))),
          this.database.select().from(voiceCallEvents).where(and(eq(voiceCallEvents.organisationId, organisationId), inArray(voiceCallEvents.voiceCallId, voiceCallIds))),
          this.database.select({ normalisedDestination: suppressions.normalisedDestination, consentState: suppressions.consentState, recordedAt: suppressions.recordedAt, id: suppressions.id }).from(suppressions).where(and(eq(suppressions.organisationId, organisationId), eq(suppressions.channel, 'VOICE')))
        ]);
    const invoicesByCall = new Map<string, VoiceInvoiceReference[]>();
    for (const row of voiceInvoiceRows) {
      const values = invoicesByCall.get(row.voiceCallId) ?? [];
      values.push({ invoiceId: row.invoiceId, invoiceNumber: row.invoiceNumber });
      invoicesByCall.set(row.voiceCallId, values);
    }
    const callsById = new Map(voiceCallRows.map((row) => [row.call.id, row]));
    const events: CustomerActivityRecord[] = [];
    for (const invoice of invoiceRows) events.push({ id: `invoice:${invoice.id}`, occurredAt: invoice.updatedAt, label: 'Xero invoice updated', source: 'Xero', detail: `${invoice.invoiceNumber} · ${invoice.status} · ${invoice.currency} ${invoice.amountDue}`, tone: invoice.status === 'PAID' ? 'positive' : 'neutral' });
    for (const row of approvalRows) events.push({ id: `approval:${row.approval.id}`, occurredAt: row.approval.decidedAt ?? row.approval.createdAt, label: `Reminder ${row.approval.status.toLowerCase()}`, source: 'AccountPulse', detail: `${row.invoiceNumber} · source version ${row.approval.sourceVersion}`, tone: row.approval.status === 'EXPIRED' || row.approval.status === 'REJECTED' ? 'warning' : 'neutral' });
    for (const row of outboundRows) events.push({ id: `outbound:${row.message.id}`, occurredAt: row.message.completedAt ?? row.message.updatedAt, label: `${row.message.channel === 'SMS' ? 'SMS' : 'Xero email'} ${row.message.status.toLowerCase()}`, source: row.message.channel === 'SMS' ? 'AccountPulse messaging' : 'Xero', detail: row.invoiceNumber, tone: row.message.status === 'DELIVERED' || row.message.status === 'ACCEPTED' ? 'positive' : row.message.status === 'FAILED' || row.message.status === 'UNKNOWN' ? 'warning' : 'neutral' });
    for (const row of inboundRows) events.push({ id: `inbound:${row.message.id}`, occurredAt: row.message.receivedAt, label: 'Customer replied', source: 'AccountPulse messaging', detail: row.message.body, tone: 'neutral' });
    for (const row of replyRows) events.push({ id: `reply:${row.reply.id}`, occurredAt: row.reply.sentAt ?? row.reply.createdAt, label: 'Operator replied', source: 'AccountPulse messaging', detail: row.reply.content, tone: row.reply.status === 'FAILED' ? 'warning' : 'neutral' });
    for (const pause of pauseRows) events.push({ id: `pause:${pause.id}`, occurredAt: pause.endedAt ?? pause.startedAt, label: pause.active ? 'Chasing paused' : 'Chasing resumed', source: 'AccountPulse', detail: pause.reason ?? pause.kind, tone: pause.active ? 'warning' : 'positive' });
    for (const dispute of disputeRows) events.push({ id: `dispute:${dispute.id}`, occurredAt: dispute.resolvedAt ?? dispute.recordedAt, label: `Dispute ${dispute.status.toLowerCase()}`, source: 'Operator', detail: dispute.reason, tone: dispute.status === 'OPEN' ? 'warning' : 'neutral' });
    for (const promise of promiseRows) events.push({ id: `promise:${promise.id}`, occurredAt: promise.endedAt ?? promise.recordedAt, label: 'Promise to pay', source: 'Operator', detail: `${promise.status} · promised ${promise.promisedDate} + ${promise.graceDays} grace days`, tone: promise.status === 'MISSED' ? 'warning' : 'neutral' });
    for (const task of taskRows) {
      const isVoiceReview = task.kind === 'VOICE_CONTACT_REVIEW' || task.kind === 'VOICE_OUTCOME_REVIEW';
      const detail = task.kind === 'VOICE_CONTACT_REVIEW'
        ? 'Review the customer\'s phone details before another voice reminder.'
        : task.kind === 'VOICE_OUTCOME_REVIEW'
          ? 'Review this voice call outcome before another reminder.'
          : task.resolutionNote ?? task.summary;
      events.push({
        id: `task:${task.id}`,
        occurredAt: task.completedAt ?? task.createdAt,
        label: isVoiceReview ? (task.kind === 'VOICE_CONTACT_REVIEW' ? 'Voice contact details need review' : 'Voice outcome needs review') : `Escalation ${task.status.toLowerCase()}`,
        source: isVoiceReview ? 'AccountPulse Voice' : 'AccountPulse',
        detail,
        tone: task.status === 'OPEN' ? 'warning' : 'neutral',
        ...(isVoiceReview && task.status === 'OPEN' ? { href: '/escalations', actionLabel: 'Review escalation' } : {})
      });
    }
    for (const audit of auditRows) events.push({ id: `audit:${audit.id}`, occurredAt: audit.occurredAt, label: audit.eventType === 'CUSTOMER_NOTE_ADDED' ? 'Customer note' : audit.eventType.replaceAll('_', ' ').toLowerCase(), source: 'Operator', detail: typeof audit.afterValue?.note === 'string' ? audit.afterValue.note : typeof audit.afterValue?.reason === 'string' ? audit.afterValue.reason : 'Recorded in the audit trail', tone: 'neutral' });
    for (const row of voiceCallRows) {
      const invoiceReferences = [...(invoicesByCall.get(row.call.id) ?? [])]
        .sort((left, right) => left.invoiceNumber.localeCompare(right.invoiceNumber));
      const invoiceNumbers = invoiceReferences.map((invoice) => invoice.invoiceNumber);
      const links = voiceInvoiceLinks(invoiceReferences);
      const detail = voiceCallDetail(
        invoiceNumbers,
        row.call.purpose,
        row.actorName,
        row.call.source,
        row.sequenceName,
        row.call.stageKey
      );
      const source = voiceCallSource(row.call.purpose, row.call.source);
      if (row.call.approvedAt) events.push({ id: `voice:${row.call.id}:approved`, occurredAt: row.call.approvedAt, label: voiceCallLabel('Voice call facts approved', row.call.purpose), source, detail, tone: 'neutral', links });
      if (row.call.queuedAt) events.push({ id: `voice:${row.call.id}:queued`, occurredAt: row.call.queuedAt, label: voiceCallLabel('Voice call queued', row.call.purpose), source, detail, tone: 'neutral', links });
      if (row.call.providerAcceptedAt) events.push({ id: `voice:${row.call.id}:accepted`, occurredAt: row.call.providerAcceptedAt, label: voiceCallLabel('Voice provider accepted the call', row.call.purpose), source, detail, tone: 'neutral', links });
      if (row.call.state === 'UNKNOWN') events.push({ id: `voice:${row.call.id}:unknown`, occurredAt: row.call.updatedAt, label: voiceCallLabel('Voice call outcome needs review', row.call.purpose), source, detail: `${detail} · outcome could not be confirmed safely`, tone: 'warning', links, ...(row.call.purpose === 'CUSTOMER' ? { href: '/escalations', actionLabel: 'Review escalation' } : {}) });
      if (row.call.state === 'FAILED' && !voiceEventRows.some((event) => event.voiceCallId === row.call.id && event.eventType === 'VOICE_CALL_FAILED')) events.push({ id: `voice:${row.call.id}:failed`, occurredAt: row.call.completedAt ?? row.call.updatedAt, label: voiceCallLabel('Voice call failed', row.call.purpose), source, detail, tone: 'warning', links });
    }
    for (const event of voiceEventRows) {
      const presentation = voiceEventPresentation[event.eventType];
      if (!presentation) continue;
      const call = callsById.get(event.voiceCallId);
      const invoiceReferences = [...(invoicesByCall.get(event.voiceCallId) ?? [])]
        .sort((left, right) => left.invoiceNumber.localeCompare(right.invoiceNumber));
      events.push({
        id: `voice-event:${event.id}`,
        occurredAt: event.occurredAt,
        label: voiceCallLabel(presentation.label, call?.call.purpose),
        source: voiceCallSource(call?.call.purpose, call?.call.source),
        detail: voiceCallDetail(
          invoiceReferences.map((invoice) => invoice.invoiceNumber),
          call?.call.purpose,
          call?.actorName,
          call?.call.source,
          call?.sequenceName,
          call?.call.stageKey
        ),
        tone: presentation.tone,
        links: voiceInvoiceLinks(invoiceReferences),
        ...((event.eventType === 'VOICE_WRONG_PERSON_REPORTED' || event.eventType === 'VOICE_INVALID_DESTINATION') && call?.call.purpose === 'CUSTOMER' ? { href: '/escalations', actionLabel: 'Review escalation' } : {})
      });
    }
    const suppressedDestinations = new Map(voiceSuppressionRows.filter((row) => row.consentState === 'SUPPRESSED').map((row) => [row.normalisedDestination, row]));
    for (const row of voiceCallRows) {
      if (row.call.purpose === 'TEST') continue;
      const suppression = suppressedDestinations.get(row.call.destinationNumber);
      if (!suppression) continue;
      const invoiceReferences = [...(invoicesByCall.get(row.call.id) ?? [])]
        .sort((left, right) => left.invoiceNumber.localeCompare(right.invoiceNumber));
      events.push({ id: `voice-suppression:${suppression.id}:${row.call.id}`, occurredAt: suppression.recordedAt, label: 'Voice reminders suppressed', source: voiceCallSource(row.call.purpose, row.call.source), detail: voiceInvoiceDetail(invoiceReferences.map((invoice) => invoice.invoiceNumber)), tone: 'warning', href: '/escalations', actionLabel: 'Review escalation', links: voiceInvoiceLinks(invoiceReferences) });
    }
    return events.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id));
  }
}
