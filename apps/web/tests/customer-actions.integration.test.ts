import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { approvals, auditEvents, contactChannels, contacts, createDatabase, invoiceChases, invoices, migrateDatabase, organisations, pauses, paymentPromises, reminderSequenceVersions, reminderSequences, stageInstances, users } from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { createCustomerOperations } from '../src/app/(protected)/customers/[customerId]/customer-operations.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T02:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedCustomer() {
  const organisationId = randomUUID(); const userId = randomUUID(); const customerId = randomUUID(); const invoiceId = randomUUID(); const sequenceId = randomUUID(); const versionId = randomUUID(); const chaseId = randomUUID(); const stageId = randomUUID(); const approvalId = randomUUID();
  await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Customer test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
  await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Operator' });
  await client.db.insert(contacts).values({ id: customerId, organisationId, xeroContactId: randomUUID(), name: 'Customer', email: 'accounts@example.invalid' });
  await client.db.insert(contactChannels).values({ organisationId, contactId: customerId, kind: 'SMS', sourceValue: '0400 000 000', normalisedValue: '+61400000000' });
  await client.db.insert(invoices).values({ id: invoiceId, organisationId, xeroInvoiceId: randomUUID(), contactId: customerId, invoiceNumber: 'INV-200', type: 'ACCREC', status: 'AUTHORISED', issueDate: '2026-08-01', dueDate: '2026-08-20', amountDue: '100', currency: 'AUD', onlineInvoiceUrl: 'https://in.xero.test/INV-200', syncVersion: 1 });
  await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Standard', mode: 'REVIEW' });
  await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'ACTIVE' });
  await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId, sequenceId, customerId, status: 'ACTIVE' });
  await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'seven-days', channel: 'SMS', status: 'PENDING_APPROVAL', scheduledAt: now, sourceVersion: 1 });
  await client.db.insert(approvals).values({ id: approvalId, organisationId, stageInstanceId: stageId, renderedPreview: 'Please pay', sourceVersion: 1, status: 'PENDING', expiresAt: new Date('2026-09-19T00:00:00Z') });
  const session: AppSession = { userId, cognitoSubject: randomUUID(), displayName: 'Operator', expiresAt: '2026-09-18T10:00:00Z', memberships: [{ organisationId, role: 'OPERATOR', active: true }] };
  return { organisationId, userId, customerId, invoiceId, approvalId, session };
}
const publisher = () => ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

describe('customer chase controls', () => {
  it('expires pending approvals when an approved phone override changes', async () => {
    const seeded = await seedCustomer();
    const service = createCustomerOperations({ database: client.db, publisher: publisher(), clock: { now: () => now } });
    const result = await service.setApprovedPhoneOverride(seeded.session, { organisationId: seeded.organisationId, customerId: seeded.customerId, phone: '0400 000 001', reason: 'Confirmed by customer' });
    const [approval] = await client.db.select().from(approvals).where(eq(approvals.id, seeded.approvalId));
    expect(result.normalisedPhone).toBe('+61400000001');
    expect(approval?.status).toBe('EXPIRED');
  });

  it('records a promise, keeps the customer paused, and schedules re-evaluation', async () => {
    const seeded = await seedCustomer(); const jobs = publisher();
    const service = createCustomerOperations({ database: client.db, publisher: jobs, clock: { now: () => now } });
    await service.recordPromiseToPay(seeded.session, { organisationId: seeded.organisationId, customerId: seeded.customerId, promisedDate: '2026-09-25', graceDays: 2 });
    const [promise] = await client.db.select().from(paymentPromises).where(eq(paymentPromises.contactId, seeded.customerId));
    const [pause] = await client.db.select().from(pauses).where(and(eq(pauses.contactId, seeded.customerId), eq(pauses.active, true)));
    expect(promise?.status).toBe('ACTIVE');
    expect(pause?.kind).toBe('PROMISE_TO_PAY');
    expect(jobs.publish).toHaveBeenCalledOnce();
  });

  it('stores a plain-text note and rejects HTML', async () => {
    const seeded = await seedCustomer();
    const service = createCustomerOperations({ database: client.db, publisher: publisher(), clock: { now: () => now } });
    await service.addCustomerNote(seeded.session, { organisationId: seeded.organisationId, customerId: seeded.customerId, note: 'Customer asked for a call after 3 pm.' });
    await expect(service.addCustomerNote(seeded.session, { organisationId: seeded.organisationId, customerId: seeded.customerId, note: '<b>unsafe</b>' })).rejects.toThrow('NOTE_MUST_BE_PLAIN_TEXT');
    const notes = await client.db.select().from(auditEvents).where(and(eq(auditEvents.organisationId, seeded.organisationId), eq(auditEvents.eventType, 'CUSTOMER_NOTE_ADDED')));
    expect(notes).toHaveLength(1);
  });

  it('queues an explicitly confirmed, editable manual SMS for the invoice', async () => {
    const seeded = await seedCustomer();
    const jobs = publisher();
    const service = createCustomerOperations({ database: client.db, publisher: jobs, clock: { now: () => now } });
    const requestId = randomUUID();
    const message = 'Hi Customer, invoice INV-200 is overdue. Pay here: https://in.xero.test/INV-200';

    await service.sendManualReminder(seeded.session, {
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      invoiceId: seeded.invoiceId,
      channel: 'SMS',
      message,
      confirmed: true,
      requestId
    });

    const [stage] = await client.db.select().from(stageInstances).where(eq(stageInstances.id, requestId));
    const [approval] = await client.db.select().from(approvals).where(eq(approvals.stageInstanceId, requestId));
    expect(stage).toMatchObject({ stageKey: 'manual', channel: 'SMS', status: 'QUEUED' });
    expect(approval).toMatchObject({ renderedPreview: message, status: 'APPROVED', decidedByUserId: seeded.userId });
    expect(jobs.publish).toHaveBeenCalledOnce();
  });

  it('queues a confirmed Xero invoice email only once for a repeated request', async () => {
    const seeded = await seedCustomer();
    const jobs = publisher();
    const service = createCustomerOperations({ database: client.db, publisher: jobs, clock: { now: () => now } });
    const input = {
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      invoiceId: seeded.invoiceId,
      channel: 'XERO_EMAIL' as const,
      confirmed: true,
      requestId: randomUUID()
    };

    await service.sendManualReminder(seeded.session, input);
    await service.sendManualReminder(seeded.session, input);

    const stages = await client.db.select().from(stageInstances).where(eq(stageInstances.id, input.requestId));
    const approvalsForRequest = await client.db.select().from(approvals).where(eq(approvals.stageInstanceId, input.requestId));
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ stageKey: 'manual', channel: 'XERO_EMAIL', status: 'QUEUED' });
    expect(approvalsForRequest).toHaveLength(1);
    expect(approvalsForRequest[0]?.renderedPreview).toBe('Xero invoice email for INV-200 to Customer');
    expect(jobs.publish).toHaveBeenCalledOnce();
  });

  it('rejects a manual reminder without explicit confirmation', async () => {
    const seeded = await seedCustomer();
    const service = createCustomerOperations({ database: client.db, publisher: publisher(), clock: { now: () => now } });

    await expect(service.sendManualReminder(seeded.session, {
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      invoiceId: seeded.invoiceId,
      channel: 'SMS',
      message: 'Please pay https://in.xero.test/INV-200',
      confirmed: false,
      requestId: randomUUID()
    })).rejects.toThrow('MANUAL_SEND_CONFIRMATION_REQUIRED');
  });
});
