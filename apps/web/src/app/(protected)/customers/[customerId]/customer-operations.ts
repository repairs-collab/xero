import { createHash } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import { approvals, auditEvents, contactChannels, type Database, disputes, invoiceChases, invoices, pauses, paymentPromises, stageInstances } from '@bc5000/db/web';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export function createCustomerOperations(dependencies: { database: Database; publisher: JobPublisher; clock: { now(): Date } }) {
  const expireCustomerApprovals = async (transaction: Parameters<Parameters<Database['transaction']>[0]>[0], organisationId: string, customerId: string, now: Date) => {
    const affected = await transaction.select({ approvalId: approvals.id, stageId: stageInstances.id }).from(approvals).innerJoin(stageInstances, eq(stageInstances.id, approvals.stageInstanceId)).innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId)).innerJoin(invoices, eq(invoices.id, invoiceChases.invoiceId)).where(and(eq(approvals.organisationId, organisationId), eq(approvals.status, 'PENDING'), eq(invoices.contactId, customerId)));
    if (affected.length === 0) return;
    await transaction.update(approvals).set({ status: 'EXPIRED' }).where(inArray(approvals.id, affected.map((row) => row.approvalId)));
    await transaction.update(stageInstances).set({ status: 'CANCELLED', updatedAt: now }).where(inArray(stageInstances.id, affected.map((row) => row.stageId)));
  };

  const setApprovedPhoneOverride = async (session: AppSession, input: { organisationId: string; customerId: string; phone: string; reason: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    if (input.reason.trim() === '') throw new Error('OVERRIDE_REASON_REQUIRED');
    const parsed = parsePhoneNumberFromString(input.phone, 'AU');
    if (parsed === undefined || !parsed.isValid()) throw new Error('INVALID_PHONE_NUMBER');
    const normalisedPhone = parsed.number;
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction.update(contactChannels).set({ approvedOverride: false, approvedByUserId: null, approvedAt: null }).where(and(eq(contactChannels.organisationId, input.organisationId), eq(contactChannels.contactId, input.customerId), eq(contactChannels.kind, 'SMS'), eq(contactChannels.approvedOverride, true)));
      const [existing] = await transaction.select({ id: contactChannels.id }).from(contactChannels).where(and(eq(contactChannels.organisationId, input.organisationId), eq(contactChannels.contactId, input.customerId), eq(contactChannels.kind, 'SMS'), eq(contactChannels.normalisedValue, normalisedPhone))).limit(1);
      if (existing === undefined) await transaction.insert(contactChannels).values({ organisationId: input.organisationId, contactId: input.customerId, kind: 'SMS', sourceValue: input.phone.trim(), normalisedValue: normalisedPhone, usable: true, approvedOverride: true, overrideReason: input.reason.trim(), approvedByUserId: session.userId, approvedAt: now, updatedAt: now });
      else await transaction.update(contactChannels).set({ sourceValue: input.phone.trim(), usable: true, approvedOverride: true, overrideReason: input.reason.trim(), approvedByUserId: session.userId, approvedAt: now, updatedAt: now }).where(eq(contactChannels.id, existing.id));
      await expireCustomerApprovals(transaction, input.organisationId, input.customerId, now);
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'CUSTOMER_PHONE_OVERRIDE_SET', entityType: 'CONTACT', entityId: input.customerId, afterValue: { destinationHash: createHash('sha256').update(normalisedPhone).digest('hex'), reason: input.reason.trim() }, occurredAt: now });
    });
    return { normalisedPhone };
  };

  const pauseChasing = async (session: AppSession, input: { organisationId: string; customerId: string; reason: string; kind?: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    const reason = input.reason.trim(); if (reason === '') throw new Error('PAUSE_REASON_REQUIRED');
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction.insert(pauses).values({ organisationId: input.organisationId, kind: input.kind ?? 'MANUAL', scope: 'customer', contactId: input.customerId, active: true, reason, actorUserId: session.userId, startedAt: now });
      await transaction.update(invoiceChases).set({ status: 'PAUSED', updatedAt: now }).where(and(eq(invoiceChases.organisationId, input.organisationId), eq(invoiceChases.customerId, input.customerId), eq(invoiceChases.status, 'ACTIVE')));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'CUSTOMER_CHASING_PAUSED', entityType: 'CONTACT', entityId: input.customerId, afterValue: { reason, kind: input.kind ?? 'MANUAL' }, occurredAt: now });
    });
  };

  const clearApprovedPhoneOverride = async (session: AppSession, input: { organisationId: string; customerId: string; reason: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    const reason = input.reason.trim(); if (reason === '') throw new Error('OVERRIDE_REASON_REQUIRED');
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction.update(contactChannels).set({ approvedOverride: false, approvedByUserId: null, approvedAt: null, overrideReason: reason, updatedAt: now }).where(and(eq(contactChannels.organisationId, input.organisationId), eq(contactChannels.contactId, input.customerId), eq(contactChannels.kind, 'SMS'), eq(contactChannels.approvedOverride, true)));
      await expireCustomerApprovals(transaction, input.organisationId, input.customerId, now);
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'CUSTOMER_PHONE_OVERRIDE_CLEARED', entityType: 'CONTACT', entityId: input.customerId, afterValue: { reason }, occurredAt: now });
    });
  };

  const recordDispute = async (session: AppSession, input: { organisationId: string; customerId: string; invoiceId?: string; reason: string }) => {
    const reason = input.reason.trim(); if (reason === '') throw new Error('DISPUTE_REASON_REQUIRED');
    authorise(session, 'chase.operate', input.organisationId);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction.insert(disputes).values({ organisationId: input.organisationId, contactId: input.customerId, ...(input.invoiceId === undefined ? {} : { invoiceId: input.invoiceId }), status: 'OPEN', reason, recordedByUserId: session.userId, recordedAt: now });
      await transaction.insert(pauses).values({ organisationId: input.organisationId, kind: 'DISPUTE', scope: 'customer', contactId: input.customerId, active: true, reason, actorUserId: session.userId, startedAt: now });
      await transaction.update(invoiceChases).set({ status: 'PAUSED', updatedAt: now }).where(and(eq(invoiceChases.organisationId, input.organisationId), eq(invoiceChases.customerId, input.customerId), eq(invoiceChases.status, 'ACTIVE')));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'DISPUTE_RECORDED', entityType: 'CONTACT', entityId: input.customerId, afterValue: { reason, invoiceId: input.invoiceId ?? null }, occurredAt: now });
    });
  };

  const recordPromiseToPay = async (session: AppSession, input: { organisationId: string; customerId: string; promisedDate: string; graceDays: number }) => {
    authorise(session, 'chase.operate', input.organisationId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.promisedDate) || !Number.isFinite(Date.parse(`${input.promisedDate}T00:00:00Z`))) throw new Error('INVALID_PROMISE_DATE');
    if (!Number.isInteger(input.graceDays) || input.graceDays < 0 || input.graceDays > 30) throw new Error('INVALID_GRACE_DAYS');
    const reevaluateAt = new Date(`${input.promisedDate}T23:59:59.999Z`); reevaluateAt.setUTCDate(reevaluateAt.getUTCDate() + input.graceDays);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction.insert(paymentPromises).values({ organisationId: input.organisationId, contactId: input.customerId, promisedDate: input.promisedDate, graceDays: input.graceDays, status: 'ACTIVE', recordedByUserId: session.userId, recordedAt: now });
      await transaction.insert(pauses).values({ organisationId: input.organisationId, kind: 'PROMISE_TO_PAY', scope: 'customer', contactId: input.customerId, active: true, reason: `Payment promised for ${input.promisedDate}`, actorUserId: session.userId, startedAt: now, expiresAt: reevaluateAt });
      await transaction.update(invoiceChases).set({ status: 'PAUSED', updatedAt: now }).where(and(eq(invoiceChases.organisationId, input.organisationId), eq(invoiceChases.customerId, input.customerId), eq(invoiceChases.status, 'ACTIVE')));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'PAYMENT_PROMISE_RECORDED', entityType: 'CONTACT', entityId: input.customerId, afterValue: { promisedDate: input.promisedDate, graceDays: input.graceDays }, occurredAt: now });
    });
    await dependencies.publisher.publish(jobNames.remindersCalculate, { organisationId: input.organisationId }, { singletonKey: `promise:${input.customerId}:${input.promisedDate}`, startAfter: reevaluateAt });
  };

  const resumeChasing = async (session: AppSession, input: { organisationId: string; customerId: string; reason: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    const reason = input.reason.trim(); if (reason === '') throw new Error('RESUME_REASON_REQUIRED');
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction.update(pauses).set({ active: false, endedAt: now }).where(and(eq(pauses.organisationId, input.organisationId), eq(pauses.contactId, input.customerId), eq(pauses.active, true)));
      await transaction.update(disputes).set({ status: 'RESOLVED', resolvedAt: now }).where(and(eq(disputes.organisationId, input.organisationId), eq(disputes.contactId, input.customerId), eq(disputes.status, 'OPEN')));
      await transaction.update(paymentPromises).set({ status: 'CANCELLED', endedAt: now }).where(and(eq(paymentPromises.organisationId, input.organisationId), eq(paymentPromises.contactId, input.customerId), eq(paymentPromises.status, 'ACTIVE')));
      await transaction.update(invoiceChases).set({ status: 'ACTIVE', updatedAt: now }).where(and(eq(invoiceChases.organisationId, input.organisationId), eq(invoiceChases.customerId, input.customerId), eq(invoiceChases.status, 'PAUSED')));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'CUSTOMER_CHASING_RESUMED', entityType: 'CONTACT', entityId: input.customerId, afterValue: { reason, recalculationRequired: true }, occurredAt: now });
    });
    await dependencies.publisher.publish(jobNames.remindersCalculate, { organisationId: input.organisationId }, { singletonKey: `resume:${input.customerId}:${now.toISOString()}` });
  };

  const addCustomerNote = async (session: AppSession, input: { organisationId: string; customerId: string; note: string }) => {
    authorise(session, 'chase.operate', input.organisationId);
    const note = input.note.trim(); if (note === '') throw new Error('NOTE_REQUIRED'); if (/[<>]/.test(note)) throw new Error('NOTE_MUST_BE_PLAIN_TEXT');
    await dependencies.database.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'CUSTOMER_NOTE_ADDED', entityType: 'CONTACT', entityId: input.customerId, afterValue: { note }, occurredAt: dependencies.clock.now() });
  };

  return { setApprovedPhoneOverride, clearApprovedPhoneOverride, pauseChasing, recordDispute, recordPromiseToPay, resumeChasing, addCustomerNote };
}
