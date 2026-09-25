import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '@bc5000/db';
import {
  approvals,
  contactChannels,
  contacts,
  invoiceChases,
  invoices,
  organisations,
  reminderSequenceVersions,
  reminderSequences,
  stageInstances,
  tasks
} from '@bc5000/db';
import {
  XeroRateLimited,
  type ListOutstandingInvoicesOptions,
  type XeroContact,
  type XeroInvoice,
  type XeroResult
} from '@bc5000/integrations/xero';

import { runIncrementalSync } from '../src/handlers/xero-incremental-sync.js';
import {
  runInvoiceRefresh,
  type XeroSyncClient
} from '../src/handlers/xero-invoice-refresh.js';
import { runInitialSync } from '../src/handlers/xero-initial-sync.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const database = createDatabase(databaseUrl);
const noRateLimit = {
  limit: null,
  remaining: null,
  dailyRemaining: null,
  problem: null,
  retryAfterSeconds: null
};
const result = <T>(data: T): XeroResult<T> => ({
  data,
  rateLimit: noRateLimit
});

class FakeXeroSyncClient implements XeroSyncClient {
  invoices = new Map<string, XeroInvoice>();
  contacts = new Map<string, XeroContact>();
  listedInvoices: XeroInvoice[] = [];
  listOptions: ListOutstandingInvoicesOptions[] = [];
  listContactsCalls: string[][] = [];
  getOnlineInvoiceUrlCalls = 0;
  listError: Error | null = null;

  listOutstandingInvoices(
    options: ListOutstandingInvoicesOptions = {}
  ): Promise<XeroResult<XeroInvoice[]>> {
    this.listOptions.push(options);
    if (this.listError !== null) return Promise.reject(this.listError);
    return Promise.resolve(result(this.listedInvoices));
  }

  getInvoice(invoiceId: string): Promise<XeroResult<XeroInvoice>> {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) {
      return Promise.reject(new Error('Missing fake invoice'));
    }
    return Promise.resolve(result(invoice));
  }

  getContact(contactId: string): Promise<XeroResult<XeroContact>> {
    const contact = this.contacts.get(contactId);
    if (contact === undefined) {
      return Promise.reject(new Error('Missing fake contact'));
    }
    return Promise.resolve(result(contact));
  }

  listContacts(contactIds: string[]): Promise<XeroResult<XeroContact[]>> {
    this.listContactsCalls.push(contactIds);
    return Promise.resolve(
      result(
        contactIds.map((contactId) => {
          const contact = this.contacts.get(contactId);
          if (contact === undefined) throw new Error('Missing fake contact');
          return contact;
        })
      )
    );
  }

  getOnlineInvoiceUrl(
    invoiceId: string
  ): Promise<XeroResult<string>> {
    this.getOnlineInvoiceUrlCalls += 1;
    return Promise.resolve(
      result(`https://in.xero.test/${encodeURIComponent(invoiceId)}`)
    );
  }
}

const fixedClock = {
  now: () => new Date('2026-09-18T02:00:00.000Z')
};

beforeAll(async () => {
  await migrateDatabase(database.db);
});

afterAll(async () => {
  await database.pool.end();
});

const seedOrganisation = async (cursor: string | null = null) => {
  const organisationId = randomUUID();
  await database.db.insert(organisations).values({
    id: organisationId,
    name: 'Sync Test Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    xeroSyncCursor: cursor
  });
  return organisationId;
};

const seedApprovedReminder = async () => {
  const organisationId = await seedOrganisation();
  const contactId = randomUUID();
  const xeroContactId = randomUUID();
  const invoiceId = randomUUID();
  const xeroInvoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const chaseId = randomUUID();
  const stageInstanceId = randomUUID();
  const approvalId = randomUUID();

  await database.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId,
    name: 'Existing Customer',
    active: true
  });
  await database.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId,
    contactId,
    invoiceNumber: 'INV-1',
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '120.0000',
    currency: 'AUD',
    syncVersion: 4
  });
  await database.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Sequence ${sequenceId}`,
    mode: 'REVIEW'
  });
  await database.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {}
  });
  await database.db.insert(invoiceChases).values({
    id: chaseId,
    organisationId,
    invoiceId,
    customerId: contactId,
    sequenceId,
    status: 'ACTIVE'
  });
  await database.db.insert(stageInstances).values({
    id: stageInstanceId,
    organisationId,
    invoiceChaseId: chaseId,
    sequenceVersionId,
    stageKey: 'seven-days',
    channel: 'SMS',
    status: 'PENDING_APPROVAL',
    scheduledAt: new Date('2026-09-18T00:00:00Z'),
    sourceVersion: 4
  });
  await database.db.insert(approvals).values({
    id: approvalId,
    organisationId,
    stageInstanceId,
    renderedPreview: 'Old amount $120',
    sourceVersion: 4,
    status: 'APPROVED',
    expiresAt: new Date('2026-09-19T00:00:00Z')
  });

  return {
    organisationId,
    contactId,
    xeroContactId,
    invoiceId,
    xeroInvoiceId,
    chaseId,
    approvalId
  };
};

const xeroContact = (
  id: string,
  phoneCandidates: XeroContact['phoneCandidates'] = [
    { type: 'MOBILE', number: '0400 000 001' }
  ]
): XeroContact => ({
  id,
  name: 'Updated Customer',
  active: true,
  email: 'accounts@example.invalid',
  phones: phoneCandidates.map((phone) => phone.number),
  phoneCandidates
});

const xeroInvoice = (
  id: string,
  contactId: string,
  patch: Partial<XeroInvoice> = {}
): XeroInvoice => ({
  id,
  invoiceNumber: 'INV-1',
  contactId,
  contactName: 'Updated Customer',
  type: 'ACCREC',
  status: 'AUTHORISED',
  issueDate: '2026-08-01',
  dueDate: '2026-08-31',
  amountDue: '80.00',
  currency: 'AUD',
  updatedAt: '2026-09-18T01:00:00Z',
  ...patch
});

describe('targeted Xero invoice refresh', () => {
  it('upserts changed invoices and invalidates stale approvals', async () => {
    const seeded = await seedApprovedReminder();
    const xero = new FakeXeroSyncClient();
    xero.invoices.set(
      seeded.xeroInvoiceId,
      xeroInvoice(seeded.xeroInvoiceId, seeded.xeroContactId)
    );
    xero.contacts.set(
      seeded.xeroContactId,
      xeroContact(seeded.xeroContactId)
    );

    await runInvoiceRefresh(
      { database: database.db, xero, clock: fixedClock },
      {
        organisationId: seeded.organisationId,
        invoiceId: seeded.xeroInvoiceId
      }
    );

    const [approval] = await database.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, seeded.approvalId));
    const [stored] = await database.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, seeded.invoiceId));
    const phoneRows = await database.db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.contactId, seeded.contactId));

    expect(approval?.status).toBe('EXPIRED');
    expect(stored).toMatchObject({
      amountDue: '80.0000',
      syncVersion: 5
    });
    expect(phoneRows).toEqual([
      expect.objectContaining({
        normalisedValue: '+61400000001',
        approvedOverride: false
      })
    ]);
  });

  it('closes active chasing when Xero reports payment', async () => {
    const seeded = await seedApprovedReminder();
    const xero = new FakeXeroSyncClient();
    xero.invoices.set(
      seeded.xeroInvoiceId,
      xeroInvoice(seeded.xeroInvoiceId, seeded.xeroContactId, {
        status: 'PAID',
        amountDue: '0.00'
      })
    );
    xero.contacts.set(
      seeded.xeroContactId,
      xeroContact(seeded.xeroContactId)
    );

    await runInvoiceRefresh(
      { database: database.db, xero, clock: fixedClock },
      {
        organisationId: seeded.organisationId,
        invoiceId: seeded.xeroInvoiceId
      }
    );

    const [chase] = await database.db
      .select()
      .from(invoiceChases)
      .where(eq(invoiceChases.id, seeded.chaseId));
    expect(chase).toMatchObject({
      status: 'CLOSED',
      closedReason: 'XERO_PAID'
    });
  });

  it('creates only one data-quality task when no phone is usable', async () => {
    const seeded = await seedApprovedReminder();
    const xero = new FakeXeroSyncClient();
    xero.invoices.set(
      seeded.xeroInvoiceId,
      xeroInvoice(seeded.xeroInvoiceId, seeded.xeroContactId)
    );
    xero.contacts.set(
      seeded.xeroContactId,
      xeroContact(seeded.xeroContactId, [
        { type: 'MOBILE', number: 'not-a-phone' }
      ])
    );
    const dependencies = {
      database: database.db,
      xero,
      clock: fixedClock
    };
    const payload = {
      organisationId: seeded.organisationId,
      invoiceId: seeded.xeroInvoiceId
    };

    await runInvoiceRefresh(dependencies, payload);
    await runInvoiceRefresh(dependencies, payload);

    const taskRows = await database.db
      .select()
      .from(tasks)
      .where(eq(tasks.contactId, seeded.contactId));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({
      kind: 'DATA_QUALITY_PHONE',
      status: 'OPEN'
    });
  });
});

describe('Xero collection synchronisation', () => {
  it('loads contacts once for a collection and de-duplicates their IDs', async () => {
    const organisationId = await seedOrganisation();
    const xero = new FakeXeroSyncClient();
    const firstContactId = randomUUID();
    const secondContactId = randomUUID();
    xero.listedInvoices = [
      xeroInvoice(randomUUID(), firstContactId),
      xeroInvoice(randomUUID(), firstContactId),
      xeroInvoice(randomUUID(), secondContactId)
    ];
    xero.contacts.set(firstContactId, xeroContact(firstContactId));
    xero.contacts.set(secondContactId, xeroContact(secondContactId));

    await runInitialSync(
      { database: database.db, xero, clock: fixedClock },
      { organisationId }
    );

    expect(xero.listContactsCalls).toEqual([
      [firstContactId, secondContactId]
    ]);
  });

  it('stores invoices returned by an initial sync', async () => {
    const organisationId = await seedOrganisation();
    const xero = new FakeXeroSyncClient();
    const xeroContactId = randomUUID();
    const xeroInvoiceId = randomUUID();
    xero.listedInvoices = [xeroInvoice(xeroInvoiceId, xeroContactId)];
    xero.contacts.set(xeroContactId, xeroContact(xeroContactId));

    await runInitialSync(
      { database: database.db, xero, clock: fixedClock },
      { organisationId }
    );

    const stored = await database.db
      .select()
      .from(invoices)
      .where(eq(invoices.xeroInvoiceId, xeroInvoiceId));
    expect(stored).toHaveLength(1);
    expect(xero.getOnlineInvoiceUrlCalls).toBe(0);
  });

  it('preserves a cached online-invoice URL during a targeted refresh', async () => {
    const seeded = await seedApprovedReminder();
    const cachedUrl = 'https://in.xero.test/cached-link';
    await database.db
      .update(invoices)
      .set({ onlineInvoiceUrl: cachedUrl })
      .where(eq(invoices.id, seeded.invoiceId));
    const xero = new FakeXeroSyncClient();
    xero.invoices.set(
      seeded.xeroInvoiceId,
      xeroInvoice(seeded.xeroInvoiceId, seeded.xeroContactId)
    );
    xero.contacts.set(
      seeded.xeroContactId,
      xeroContact(seeded.xeroContactId)
    );

    await runInvoiceRefresh(
      { database: database.db, xero, clock: fixedClock },
      {
        organisationId: seeded.organisationId,
        invoiceId: seeded.xeroInvoiceId
      }
    );

    const [stored] = await database.db
      .select({ onlineInvoiceUrl: invoices.onlineInvoiceUrl })
      .from(invoices)
      .where(eq(invoices.id, seeded.invoiceId));
    expect(stored?.onlineInvoiceUrl).toBe(cachedUrl);
    expect(xero.getOnlineInvoiceUrlCalls).toBe(0);
  });

  it('uses a two-minute cursor overlap and advances only after success', async () => {
    const organisationId = await seedOrganisation(
      '2026-09-18T00:00:00.000Z'
    );
    const xero = new FakeXeroSyncClient();

    await runIncrementalSync(
      { database: database.db, xero, clock: fixedClock },
      { organisationId }
    );

    expect(xero.listOptions).toEqual([
      { ifModifiedSince: '2026-09-17T23:58:00.000Z' }
    ]);
    const [organisation] = await database.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    expect(organisation?.xeroSyncCursor).toBe(
      '2026-09-18T02:00:00.000Z'
    );
  });

  it('does not advance the cursor when Xero rate-limits the scan', async () => {
    const originalCursor = '2026-09-18T00:00:00.000Z';
    const organisationId = await seedOrganisation(originalCursor);
    const xero = new FakeXeroSyncClient();
    xero.listError = new XeroRateLimited(30);

    await expect(
      runIncrementalSync(
        { database: database.db, xero, clock: fixedClock },
        { organisationId }
      )
    ).rejects.toBeInstanceOf(XeroRateLimited);

    const [organisation] = await database.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    expect(organisation?.xeroSyncCursor).toBe(originalCursor);
  });
});
