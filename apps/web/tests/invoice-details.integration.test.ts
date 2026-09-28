import { randomUUID } from 'node:crypto';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  organisations,
  outboundMessages,
  reminderSequences,
  reminderWhitelistEntries
} from '@bc5000/db';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { ...props, href, children })
}));

import { loadInvoiceDetails } from '../src/app/(protected)/invoices/[invoiceId]/invoice-details.js';
import { InvoiceDetailsView } from '../src/components/invoice-details-view.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-28T05:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedInvoiceDetails() {
  const organisationId = randomUUID();
  const foreignOrganisationId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const foreignInvoiceId = randomUUID();
  await client.db.insert(organisations).values([
    {
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Invoice details org',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    },
    {
      id: foreignOrganisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Foreign invoice org',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    }
  ]);
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Accurate Stored Client',
    email: 'accounts@example.invalid'
  });
  await client.db.insert(invoices).values([
    {
      id: invoiceId,
      organisationId,
      xeroInvoiceId: 'xero-invoice-stored-1',
      contactId,
      invoiceNumber: 'INV-STORED-1',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '432.1000',
      total: '500.0000',
      currency: 'AUD',
      onlineInvoiceUrl: 'https://in.xero.test/INV-STORED-1',
      syncVersion: 7,
      xeroUpdatedAt: new Date('2026-09-27T23:30:00.000Z'),
      updatedAt: now
    },
    {
      id: foreignInvoiceId,
      organisationId: foreignOrganisationId,
      xeroInvoiceId: 'foreign-xero-invoice',
      contactId,
      invoiceNumber: 'FOREIGN-INVOICE-SECRET',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '999',
      currency: 'AUD',
      syncVersion: 1
    }
  ]);
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: 'Standard debt recovery',
    mode: 'REVIEW'
  });
  await client.db.insert(invoiceChases).values({
    organisationId,
    invoiceId,
    customerId: contactId,
    sequenceId,
    status: 'ACTIVE',
    startedAt: new Date('2026-09-01T00:00:00.000Z')
  });
  await client.db.insert(reminderWhitelistEntries).values([
    {
      organisationId,
      scope: 'CLIENT',
      contactId,
      reason: 'Client-wide hold',
      createdAt: new Date('2026-09-20T00:00:00.000Z')
    },
    {
      organisationId,
      scope: 'INVOICE',
      contactId,
      invoiceId,
      reason: 'Invoice dispute',
      createdAt: new Date('2026-09-21T00:00:00.000Z')
    }
  ]);
  await client.db.insert(outboundMessages).values([
    {
      organisationId,
      contactId,
      invoiceId,
      channel: 'SMS',
      source: 'MANUAL_REMINDER',
      recipientKey: '+61400000001',
      content: 'Stored outgoing reminder content',
      contentHash: 'stored-hash',
      status: 'DELIVERED',
      idempotencyKey: randomUUID(),
      createdAt: new Date('2026-09-22T01:00:00.000Z'),
      updatedAt: new Date('2026-09-22T01:01:00.000Z'),
      completedAt: new Date('2026-09-22T01:01:00.000Z')
    },
    {
      organisationId: foreignOrganisationId,
      invoiceId: foreignInvoiceId,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: '+61499999999',
      content: 'FOREIGN MESSAGE SECRET',
      contentHash: 'foreign-hash',
      status: 'DELIVERED',
      idempotencyKey: randomUUID()
    }
  ]);
  return {
    organisationId,
    foreignOrganisationId,
    contactId,
    invoiceId,
    foreignInvoiceId
  };
}

describe('invoice details', () => {
  it('renders only stored Xero fields, related history, chase state, and active exclusions', async () => {
    const seeded = await seedInvoiceDetails();
    const model = await loadInvoiceDetails(client.db, {
      organisationId: seeded.organisationId,
      invoiceId: seeded.invoiceId
    });
    expect(model).not.toBeNull();
    if (model === null) throw new Error('Expected invoice details');

    const html = renderToStaticMarkup(
      createElement(InvoiceDetailsView, { model })
    );
    expect(html).toContain('INV-STORED-1');
    expect(html).toContain('Authorised');
    expect(html).toContain('1 Aug 2026');
    expect(html).toContain('31 Aug 2026');
    expect(html).toContain('$432.10');
    expect(html).toContain('$500.00');
    expect(html).toContain('xero-invoice-stored-1');
    expect(html).toContain('Stored outgoing reminder content');
    expect(html).toContain('Standard debt recovery');
    expect(html).toContain('Client-wide hold');
    expect(html).toContain('Invoice dispute');
    expect(html).toContain(`/customers/${seeded.contactId}`);
    expect(html).toContain('https://in.xero.test/INV-STORED-1');
    expect(html).not.toContain('Line items');
    expect(html).not.toContain('FOREIGN MESSAGE SECRET');
    expect(html).not.toContain('FOREIGN-INVOICE-SECRET');
  });

  it('omits the Xero payment link when it was not stored', async () => {
    const seeded = await seedInvoiceDetails();
    await client.db
      .update(invoices)
      .set({ onlineInvoiceUrl: null })
      .where(eq(invoices.id, seeded.invoiceId));
    const model = await loadInvoiceDetails(client.db, {
      organisationId: seeded.organisationId,
      invoiceId: seeded.invoiceId
    });
    expect(model).not.toBeNull();
    if (model === null) throw new Error('Expected invoice details');
    const html = renderToStaticMarkup(
      createElement(InvoiceDetailsView, { model })
    );
    expect(html).toContain('No online invoice link is stored');
    expect(html).not.toContain('Open online invoice');
  });

  it('returns not found for foreign and unknown invoice IDs', async () => {
    const seeded = await seedInvoiceDetails();
    await expect(
      loadInvoiceDetails(client.db, {
        organisationId: seeded.organisationId,
        invoiceId: seeded.foreignInvoiceId
      })
    ).resolves.toBeNull();
    await expect(
      loadInvoiceDetails(client.db, {
        organisationId: seeded.organisationId,
        invoiceId: randomUUID()
      })
    ).resolves.toBeNull();
  });
});
