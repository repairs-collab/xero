import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { approvals, auditEvents, contactChannels, contacts, createDatabase, invoiceChases, invoices, migrateDatabase, organisations, pauses, paymentPromises, reminderSequenceVersions, reminderSequences, reminderWhitelistEntries, stageInstances, suppressions, users } from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { createCustomerOperations } from '../src/app/(protected)/customers/[customerId]/customer-operations.js';
import { createManualReminderService } from '../src/server/manual-reminder-service.js';

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
    expect(stage).toMatchObject({ stageKey: 'manual', origin: 'MANUAL_REMINDER', createdByUserId: seeded.userId, channel: 'SMS', status: 'QUEUED' });
    expect(approval).toMatchObject({ renderedPreview: message, status: 'APPROVED', decidedByUserId: seeded.userId });
    expect(jobs.publish).toHaveBeenCalledOnce();
  });

  it('retries queue publication after the first attempt fails without duplicating the reminder', async () => {
    const seeded = await seedCustomer();
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('Queue unavailable'))
      .mockResolvedValue(randomUUID());
    const jobs = { publish } as unknown as JobPublisher;
    const service = createCustomerOperations({ database: client.db, publisher: jobs, clock: { now: () => now } });
    const input = {
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      invoiceId: seeded.invoiceId,
      channel: 'XERO_EMAIL' as const,
      confirmed: true,
      requestId: randomUUID()
    };

    await expect(service.sendManualReminder(seeded.session, input)).rejects.toThrow('Queue unavailable');
    await expect(service.sendManualReminder(seeded.session, input)).resolves.toMatchObject({ queued: true });

    const stages = await client.db.select().from(stageInstances).where(eq(stageInstances.id, input.requestId));
    expect(stages).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('stores one Xero email reminder and safely republishes a repeated request', async () => {
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
    expect(stages[0]).toMatchObject({ stageKey: 'manual', origin: 'MANUAL_REMINDER', createdByUserId: seeded.userId, channel: 'XERO_EMAIL', status: 'QUEUED' });
    expect(approvalsForRequest).toHaveLength(1);
    expect(approvalsForRequest[0]?.renderedPreview).toBe('Xero invoice email for INV-200 to Customer');
    expect(jobs.publish).toHaveBeenCalledTimes(2);
  });

  it.each(['SMS', 'XERO_EMAIL'] as const)(
    'queues a customer-scope manual %s outside the technical allowlist',
    async (channel) => {
      const seeded = await seedCustomer();
      await client.db
        .update(organisations)
        .set({
          sendMode: 'live',
          liveSendAcknowledged: true,
          rolloutScope: 'CUSTOMER',
          recipientAllowlist: []
        })
        .where(eq(organisations.id, seeded.organisationId));
      const jobs = publisher();
      const service = createManualReminderService({
        database: client.db,
        publisher: jobs,
        clock: { now: () => now }
      });
      const requestId = randomUUID();

      await expect(
        service.queue(seeded.session, {
          organisationId: seeded.organisationId,
          customerId: seeded.customerId,
          invoiceId: seeded.invoiceId,
          channel,
          ...(channel === 'SMS'
            ? { message: 'Pay https://in.xero.test/INV-200' }
            : {}),
          confirmed: true,
          requestId,
          origin: 'CUSTOMER_PAGE'
        })
      ).resolves.toEqual({ queued: true, stageInstanceId: requestId });
      expect(jobs.publish).toHaveBeenCalledOnce();
    }
  );

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

  it('queues one editable escalation SMS with the current payment link and escalation audit source', async () => {
    const seeded = await seedCustomer();
    const jobs = publisher();
    const service = createManualReminderService({
      database: client.db,
      publisher: jobs,
      clock: { now: () => now }
    });
    const requestId = randomUUID();
    const message =
      'Final reminder for INV-200. Pay securely: https://in.xero.test/INV-200';
    const input = {
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      invoiceId: seeded.invoiceId,
      channel: 'SMS' as const,
      message,
      confirmed: true,
      requestId,
      origin: 'ESCALATION' as const
    };

    await service.queue(seeded.session, input);
    await service.queue(seeded.session, input);

    const [stage] = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, requestId));
    const storedApprovals = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.stageInstanceId, requestId));
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, seeded.organisationId),
          eq(auditEvents.eventType, 'ESCALATION_SMS_QUEUED')
        )
      );
    expect(stage).toMatchObject({
      origin: 'ESCALATION_SMS',
      stageKey: 'escalation-sms',
      createdByUserId: seeded.userId,
      status: 'QUEUED'
    });
    expect(storedApprovals).toHaveLength(1);
    expect(storedApprovals[0]?.renderedPreview).toBe(message);
    expect(events).toHaveLength(1);
    expect(events[0]?.afterValue).toMatchObject({
      stageInstanceId: requestId,
      source: 'ESCALATION_SMS'
    });
    expect(jobs.publish).toHaveBeenCalledTimes(2);
  });

  it('enforces confirmation, payment-link, segment, suppression, whitelist, and live controls', async () => {
    const confirmation = await seedCustomer();
    const service = createManualReminderService({
      database: client.db,
      publisher: publisher(),
      clock: { now: () => now }
    });
    const input = {
      organisationId: confirmation.organisationId,
      customerId: confirmation.customerId,
      invoiceId: confirmation.invoiceId,
      channel: 'SMS' as const,
      message: 'Pay https://in.xero.test/INV-200',
      confirmed: true,
      requestId: randomUUID(),
      origin: 'ESCALATION' as const
    };
    await expect(service.queue(confirmation.session, { ...input, confirmed: false })).rejects.toThrow(
      'MANUAL_SEND_CONFIRMATION_REQUIRED'
    );
    await expect(service.queue(confirmation.session, { ...input, message: 'No link' })).rejects.toThrow(
      'PAYMENT_LINK_REQUIRED'
    );
    await client.db
      .update(reminderSequenceVersions)
      .set({ maxSmsSegments: 1 })
      .where(eq(reminderSequenceVersions.organisationId, confirmation.organisationId));
    await expect(
      service.queue(confirmation.session, {
        ...input,
        message: `${'A'.repeat(180)} https://in.xero.test/INV-200`
      })
    ).rejects.toThrow(/1-segment limit/);

    const suppressed = await seedCustomer();
    await client.db
      .update(organisations)
      .set({
        sendMode: 'live',
        liveSendAcknowledged: true,
        rolloutScope: 'CUSTOMER',
        recipientAllowlist: []
      })
      .where(eq(organisations.id, suppressed.organisationId));
    await client.db.insert(suppressions).values({
      organisationId: suppressed.organisationId,
      channel: 'SMS',
      normalisedDestination: '+61400000000',
      source: 'SINCH_OPT_OUT',
      reason: 'STOP reply',
      consentState: 'SUPPRESSED',
      recordedAt: now
    });
    await expect(
      service.queue(suppressed.session, {
        ...input,
        organisationId: suppressed.organisationId,
        customerId: suppressed.customerId,
        invoiceId: suppressed.invoiceId,
        requestId: randomUUID()
      })
    ).rejects.toThrow('SMS_SUPPRESSED:SINCH_OPT_OUT');

    const whitelisted = await seedCustomer();
    await client.db
      .update(organisations)
      .set({
        sendMode: 'live',
        liveSendAcknowledged: true,
        rolloutScope: 'CUSTOMER',
        recipientAllowlist: []
      })
      .where(eq(organisations.id, whitelisted.organisationId));
    await client.db.insert(reminderWhitelistEntries).values({
      organisationId: whitelisted.organisationId,
      scope: 'INVOICE',
      contactId: whitelisted.customerId,
      invoiceId: whitelisted.invoiceId,
      reason: 'Do not chase'
    });
    await expect(
      service.queue(whitelisted.session, {
        ...input,
        organisationId: whitelisted.organisationId,
        customerId: whitelisted.customerId,
        invoiceId: whitelisted.invoiceId,
        requestId: randomUUID()
      })
    ).rejects.toThrow('REMINDER_WHITELISTED');

    const live = await seedCustomer();
    await client.db
      .update(organisations)
      .set({ sendMode: 'live', liveSendAcknowledged: true, recipientAllowlist: [] })
      .where(eq(organisations.id, live.organisationId));
    await expect(
      service.queue(live.session, {
        ...input,
        organisationId: live.organisationId,
        customerId: live.customerId,
        invoiceId: live.invoiceId,
        requestId: randomUUID()
      })
    ).rejects.toThrow('SMS_DESTINATION_NOT_ALLOWLISTED');
  });

  it('rejects stale and foreign invoice targets immediately before queueing', async () => {
    const seeded = await seedCustomer();
    const service = createManualReminderService({
      database: client.db,
      publisher: publisher(),
      clock: { now: () => now }
    });
    const input = {
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      invoiceId: seeded.invoiceId,
      channel: 'SMS' as const,
      message: 'Pay https://in.xero.test/INV-200',
      confirmed: true,
      requestId: randomUUID(),
      origin: 'ESCALATION' as const
    };
    await client.db
      .update(invoices)
      .set({ status: 'PAID', amountDue: '0' })
      .where(eq(invoices.id, seeded.invoiceId));
    await expect(service.queue(seeded.session, input)).rejects.toThrow(
      'INVOICE_NOT_OUTSTANDING'
    );

    const foreign = await seedCustomer();
    await expect(
      service.queue(seeded.session, {
        ...input,
        invoiceId: foreign.invoiceId,
        requestId: randomUUID()
      })
    ).rejects.toThrow('INVOICE_NOT_SENDABLE');
  });
});
