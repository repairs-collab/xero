import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contacts,
  createDatabase,
  invoices,
  migrateDatabase,
  organisations
} from '@bc5000/db';

import { getCustomerList } from '../src/server/customer-list-service.js';
import { searchDirectory } from '../src/server/global-search-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedDirectory() {
  const organisationId = randomUUID();
  const otherOrganisationId = randomUUID();
  await client.db.insert(organisations).values([
    {
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Directory test',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    },
    {
      id: otherOrganisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Other directory',
      timeZone: 'Pacific/Auckland',
      baseCurrency: 'NZD'
    }
  ]);
  const alphaId = randomUUID();
  const betaId = randomUUID();
  const hiddenId = randomUUID();
  await client.db.insert(contacts).values([
    {
      id: alphaId,
      organisationId,
      xeroContactId: randomUUID(),
      name: 'Alpha Appliances',
      email: 'zulu@example.test'
    },
    {
      id: betaId,
      organisationId,
      xeroContactId: randomUUID(),
      name: 'Beta Bakery',
      email: 'alpha@example.test'
    },
    {
      id: hiddenId,
      organisationId: otherOrganisationId,
      xeroContactId: randomUUID(),
      name: 'Alpha Secret Account',
      email: 'hidden@example.test'
    }
  ]);
  await client.db.insert(invoices).values([
    {
      organisationId,
      xeroInvoiceId: randomUUID(),
      contactId: alphaId,
      invoiceNumber: 'INV-ALPHA-001',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '50.0000',
      total: '50.0000',
      currency: 'AUD',
      syncVersion: 1
    },
    {
      organisationId,
      xeroInvoiceId: randomUUID(),
      contactId: betaId,
      invoiceNumber: 'INV-BETA-900',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-02',
      dueDate: '2026-09-01',
      amountDue: '250.0000',
      total: '250.0000',
      currency: 'AUD',
      syncVersion: 1
    },
    {
      organisationId,
      xeroInvoiceId: randomUUID(),
      contactId: betaId,
      invoiceNumber: 'INV-BETA-901',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-03',
      dueDate: '2026-09-02',
      amountDue: '25.0000',
      total: '25.0000',
      currency: 'AUD',
      syncVersion: 1
    },
    {
      organisationId: otherOrganisationId,
      xeroInvoiceId: randomUUID(),
      contactId: hiddenId,
      invoiceNumber: 'INV-ALPHA-HIDDEN',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '250.0000',
      total: '250.0000',
      currency: 'NZD',
      syncVersion: 1
    },
    {
      organisationId,
      xeroInvoiceId: randomUUID(),
      contactId: alphaId,
      invoiceNumber: 'BILL-NOT-RECEIVABLE',
      type: 'ACCPAY',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '9000.0000',
      total: '9000.0000',
      currency: 'AUD',
      syncVersion: 1
    },
    {
      organisationId,
      xeroInvoiceId: randomUUID(),
      contactId: betaId,
      invoiceNumber: 'USD-NOT-BASE-CURRENCY',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '10000.0000',
      total: '10000.0000',
      currency: 'USD',
      syncVersion: 1
    },
    {
      organisationId: otherOrganisationId,
      xeroInvoiceId: randomUUID(),
      contactId: alphaId,
      invoiceNumber: 'CROSS-ORG-NOT-VISIBLE',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '8000.0000',
      total: '8000.0000',
      currency: 'NZD',
      syncVersion: 1
    }
  ]);
  return { organisationId, otherOrganisationId, alphaId, betaId };
}

describe('directory services', () => {
  it('sorts customers by supported visible fields with stable totals', async () => {
    const seeded = await seedDirectory();

    const byEmail = await getCustomerList(client.db, {
      organisationId: seeded.organisationId,
      sort: 'email',
      direction: 'asc'
    });
    expect(byEmail.map((row) => row.contact.id)).toEqual([
      seeded.betaId,
      seeded.alphaId
    ]);

    const byInvoices = await getCustomerList(client.db, {
      organisationId: seeded.organisationId,
      sort: 'invoices',
      direction: 'desc'
    });
    expect(byInvoices.map((row) => row.invoiceCount)).toEqual([2, 1]);

    const byAmount = await getCustomerList(client.db, {
      organisationId: seeded.organisationId,
      sort: 'amount',
      direction: 'desc'
    });
    expect(byAmount.map((row) => Number(row.amountDue))).toEqual([275, 50]);
    expect(byAmount.every((row) => row.currency === 'AUD')).toBe(true);

    const otherOrganisation = await getCustomerList(client.db, {
      organisationId: seeded.otherOrganisationId,
      sort: 'amount',
      direction: 'desc'
    });
    expect(otherOrganisation).toHaveLength(1);
    expect(otherOrganisation[0]).toMatchObject({
      invoiceCount: 1,
      amountDue: '250.0000',
      currency: 'NZD'
    });
  });

  it('searches names, invoice numbers, and exact amounts without crossing organisations', async () => {
    const seeded = await seedDirectory();

    const nameResults = await searchDirectory(client.db, {
      organisationId: seeded.organisationId,
      query: 'alpha'
    });
    expect(nameResults.customers.map((result) => result.id)).toEqual([
      seeded.alphaId
    ]);
    expect(nameResults.invoices.map((result) => result.invoiceNumber)).toEqual([
      'INV-ALPHA-001'
    ]);

    const invoiceResults = await searchDirectory(client.db, {
      organisationId: seeded.organisationId,
      query: 'BETA-900'
    });
    expect(invoiceResults.invoices.map((result) => result.invoiceNumber)).toEqual([
      'INV-BETA-900'
    ]);

    const amountResults = await searchDirectory(client.db, {
      organisationId: seeded.organisationId,
      query: '$250.00'
    });
    expect(amountResults.invoices.map((result) => result.invoiceNumber)).toEqual([
      'INV-BETA-900'
    ]);
    expect(JSON.stringify(amountResults)).not.toContain('HIDDEN');
    expect(JSON.stringify(nameResults)).not.toContain('Secret');

    const percentResults = await searchDirectory(client.db, {
      organisationId: seeded.organisationId,
      query: '%'
    });
    const underscoreResults = await searchDirectory(client.db, {
      organisationId: seeded.organisationId,
      query: '_'
    });
    expect(percentResults).toEqual({ customers: [], invoices: [] });
    expect(underscoreResults).toEqual({ customers: [], invoices: [] });
  });
});
