import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approvals,
  contactChannels,
  contacts,
  createDatabase,
  disputes,
  invoiceChases,
  invoices,
  messageAttempts,
  migrateDatabase,
  organisations,
  outboundMessages,
  pauses,
  paymentPromises,
  reminderSequences,
  reminderSequenceVersions,
  stageInstances,
  suppressions,
  tasks
} from '@bc5000/db';
import {
  SinchPermanentSubmissionFailure,
  SinchRateLimited,
  SinchUnknownSubmissionOutcome,
  type SinchSendSmsInput
} from '@bc5000/integrations/sinch';
import {
  type XeroInvoice,
  type XeroResult
} from '@bc5000/integrations/xero';

import {
  executeReminder,
  type ReminderExecutionDependencies
} from '../src/handlers/reminder-execute.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const now = new Date('2026-09-18T00:00:00.000Z');
const noRateLimit = {
  limit: null,
  remaining: null,
  retryAfterSeconds: null
};
const result = <T>(data: T): XeroResult<T> => ({
  data,
  rateLimit: noRateLimit
});

class FakeXero {
  invoice!: XeroInvoice;
  onlineInvoiceUrl = 'https://in.xero.test/INV-5000';
  getInvoiceCalls = 0;
  getOnlineInvoiceUrlCalls = 0;
  emailCalls = 0;

  getInvoice(): Promise<XeroResult<XeroInvoice>> {
    this.getInvoiceCalls += 1;
    return Promise.resolve(result(this.invoice));
  }

  getOnlineInvoiceUrl(): Promise<XeroResult<string>> {
    this.getOnlineInvoiceUrlCalls += 1;
    return Promise.resolve(result(this.onlineInvoiceUrl));
  }

  emailInvoice(): Promise<{ kind: 'accepted' }> {
    this.emailCalls += 1;
    return Promise.resolve({ kind: 'accepted' });
  }
}

class FakeSinch {
  sendCalls: SinchSendSmsInput[] = [];
  error: Error | null = null;

  sendSms(input: SinchSendSmsInput) {
    this.sendCalls.push(input);
    if (this.error !== null) return Promise.reject(this.error);
    return Promise.resolve({
      kind: 'accepted' as const,
      messageId: 'sinch-message-1',
      status: 'QUEUED'
    });
  }
}

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

const seedApprovedReminder = async (options: {
  channel?: 'SMS' | 'XERO_EMAIL';
  invoiceUpdatedAt?: Date;
  invoiceStatus?: 'AUTHORISED' | 'PAID' | 'VOIDED';
  amountDue?: string;
  invoiceSourceVersion?: number;
  approvalSourceVersion?: number;
  approvalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
} = {}) => {
  const organisationId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const xeroInvoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const chaseId = randomUUID();
  const stageInstanceId = randomUUID();
  const channel = options.channel ?? 'SMS';
  const sourceVersion = options.invoiceSourceVersion ?? 3;
  const phone = '+61400000001';
  const email = 'accounts@example.invalid';

  await client.db.insert(organisations).values({
    id: organisationId,
    name: 'Execution Test Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    liveSendAcknowledged: true,
    recipientAllowlist: [phone, email]
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Alex Customer',
    active: true,
    email
  });
  await client.db.insert(contactChannels).values({
    organisationId,
    contactId,
    kind: 'SMS',
    sourceValue: phone,
    normalisedValue: phone,
    usable: true
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId,
    contactId,
    invoiceNumber: 'INV-5000',
    type: 'ACCREC',
    status: options.invoiceStatus ?? 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: options.amountDue ?? '125.5000',
    currency: 'AUD',
    onlineInvoiceUrl: 'https://in.xero.test/INV-5000',
    syncVersion: sourceVersion,
    updatedAt: options.invoiceUpdatedAt ?? now
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Execution sequence ${sequenceId}`,
    mode: 'REVIEW'
  });
  await client.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {}
  });
  await client.db.insert(invoiceChases).values({
    id: chaseId,
    organisationId,
    invoiceId,
    sequenceId,
    customerId: contactId,
    status: 'ACTIVE'
  });
  await client.db.insert(stageInstances).values({
    id: stageInstanceId,
    organisationId,
    invoiceChaseId: chaseId,
    sequenceVersionId,
    stageKey: 'seven-days',
    channel,
    status: 'QUEUED',
    scheduledAt: now,
    sourceVersion,
    updatedAt: now
  });
  await client.db.insert(approvals).values({
    organisationId,
    stageInstanceId,
    renderedPreview:
      channel === 'SMS'
        ? 'Hi Alex, invoice INV-5000 is overdue. https://in.xero.test/INV-5000'
        : 'Xero invoice email for INV-5000',
    sourceVersion: options.approvalSourceVersion ?? sourceVersion,
    status: options.approvalStatus ?? 'APPROVED',
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000)
  });

  return {
    organisationId,
    contactId,
    invoiceId,
    xeroInvoiceId,
    sequenceId,
    stageInstanceId,
    phone
  };
};

const dependencies = (
  xero: FakeXero,
  sinch: FakeSinch,
  allowance = true
): ReminderExecutionDependencies => ({
  database: client.db,
  clock: { now: () => now },
  xero,
  sinch,
  callbackUrl: 'https://bill-chaser.test/webhooks/sinch',
  xeroEmailAllowance: {
    hasSafeHeadroom: () => Promise.resolve(allowance)
  }
});

const xeroInvoice = (
  seeded: Awaited<ReturnType<typeof seedApprovedReminder>>,
  patch: Partial<XeroInvoice> = {}
): XeroInvoice => ({
  id: seeded.xeroInvoiceId,
  invoiceNumber: 'INV-5000',
  contactId: seeded.contactId,
  contactName: 'Alex Customer',
  type: 'ACCREC',
  status: 'AUTHORISED',
  issueDate: '2026-08-01',
  dueDate: '2026-08-31',
  amountDue: '125.5000',
  currency: 'AUD',
  updatedAt: now.toISOString(),
  ...patch
});

describe('executeReminder', () => {
  it('cancels without calling Sinch when payment arrives after approval', async () => {
    const seeded = await seedApprovedReminder({
      invoiceUpdatedAt: new Date(now.getTime() - 6 * 60 * 1000)
    });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded, { status: 'PAID', amountDue: '0.00' });
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'NO_BALANCE' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('stops a voided invoice before sending', async () => {
    const seeded = await seedApprovedReminder({ invoiceStatus: 'VOIDED' });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded, { status: 'VOIDED' });
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'NOT_AUTHORISED' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('sends exactly once and returns the stored outcome for a duplicate job', async () => {
    const seeded = await seedApprovedReminder();
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();
    const payload = {
      organisationId: seeded.organisationId,
      stageInstanceId: seeded.stageInstanceId
    };

    const first = await executeReminder(dependencies(xero, sinch), payload);
    const second = await executeReminder(dependencies(xero, sinch), payload);

    expect(first).toEqual({
      kind: 'sent',
      provider: 'SINCH',
      providerMessageId: 'sinch-message-1'
    });
    expect(second).toEqual(first);
    expect(sinch.sendCalls).toHaveLength(1);
    expect(sinch.sendCalls[0]?.content).toContain(
      'https://in.xero.test/INV-5000'
    );
    expect(xero.getOnlineInvoiceUrlCalls).toBe(1);
    const attempts = await client.db
      .select()
      .from(messageAttempts)
      .where(eq(messageAttempts.organisationId, seeded.organisationId));
    expect(attempts).toHaveLength(1);
  });

  it('stops on a customer reply pause', async () => {
    const seeded = await seedApprovedReminder();
    await client.db.insert(pauses).values({
      organisationId: seeded.organisationId,
      kind: 'REPLY',
      scope: 'customer',
      contactId: seeded.contactId,
      active: true,
      startedAt: new Date(now.getTime() - 60_000)
    });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'CUSTOMER_PAUSED' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('stops on a manual invoice pause', async () => {
    const seeded = await seedApprovedReminder();
    await client.db.insert(pauses).values({
      organisationId: seeded.organisationId,
      kind: 'INVOICE',
      scope: 'invoice',
      invoiceId: seeded.invoiceId,
      active: true,
      reason: 'Operator requested a hold',
      startedAt: new Date(now.getTime() - 60_000)
    });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'INVOICE_PAUSED' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('stops on an SMS opt-out suppression', async () => {
    const seeded = await seedApprovedReminder();
    await client.db.insert(suppressions).values({
      organisationId: seeded.organisationId,
      channel: 'SMS',
      normalisedDestination: seeded.phone,
      source: 'SINCH_OPT_OUT',
      reason: 'Customer opted out',
      consentState: 'SUPPRESSED'
    });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'CHANNEL_SUPPRESSED' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('stops while an invoice dispute is open', async () => {
    const seeded = await seedApprovedReminder();
    await client.db.insert(disputes).values({
      organisationId: seeded.organisationId,
      contactId: seeded.contactId,
      invoiceId: seeded.invoiceId,
      status: 'OPEN',
      reason: 'Customer disputes the amount'
    });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'DISPUTE_OPEN' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('stops during an active promise-to-pay grace period', async () => {
    const seeded = await seedApprovedReminder();
    await client.db.insert(paymentPromises).values({
      organisationId: seeded.organisationId,
      contactId: seeded.contactId,
      promisedDate: '2026-09-18',
      graceDays: 2,
      status: 'ACTIVE'
    });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'PROMISE_TO_PAY' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('expires a stale approval before sending', async () => {
    const seeded = await seedApprovedReminder({ approvalSourceVersion: 2 });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'SOURCE_CHANGED' });
    expect(sinch.sendCalls).toHaveLength(0);
  });

  it('refuses a Xero email when allowance has no safe headroom', async () => {
    const seeded = await seedApprovedReminder({ channel: 'XERO_EMAIL' });
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();

    await expect(
      executeReminder(dependencies(xero, sinch, false), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({
      kind: 'cancelled',
      reason: 'XERO_EMAIL_ALLOWANCE'
    });
    expect(xero.emailCalls).toBe(0);
  });

  it('maps an explicit Sinch rejection without retrying', async () => {
    const seeded = await seedApprovedReminder();
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();
    sinch.error = new SinchPermanentSubmissionFailure('invalid destination');

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'rejected', reason: 'PROVIDER_REJECTED' });
    expect(sinch.sendCalls).toHaveLength(1);
  });

  it('records rate limiting as a known rejection and creates an operator task', async () => {
    const seeded = await seedApprovedReminder();
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();
    sinch.error = new SinchRateLimited(30);

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'rejected', reason: 'RATE_LIMITED' });
    const operatorTasks = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.organisationId, seeded.organisationId));
    expect(operatorTasks).toHaveLength(1);
  });

  it('records an unknown result and disables automatic retry', async () => {
    const seeded = await seedApprovedReminder();
    const xero = new FakeXero();
    xero.invoice = xeroInvoice(seeded);
    const sinch = new FakeSinch();
    sinch.error = new SinchUnknownSubmissionOutcome();

    await expect(
      executeReminder(dependencies(xero, sinch), {
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId
      })
    ).resolves.toEqual({ kind: 'unknown' });
    const [outbound] = await client.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.organisationId, seeded.organisationId));
    const [stage] = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, seeded.stageInstanceId));
    expect(outbound?.status).toBe('UNKNOWN');
    expect(stage?.status).toBe('UNKNOWN');
    expect(sinch.sendCalls).toHaveLength(1);
  });
});
