import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  contacts,
  createDatabase,
  invoices,
  messageAttempts,
  migrateDatabase,
  organisations,
  outboundMessages,
  users
} from '@bc5000/db';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) =>
    createElement('a', { ...props, href, children })
}));

import { queryOutbox } from '../src/app/(protected)/outbox/outbox-query.js';
import { parseOutboxDateRange } from '../src/app/(protected)/outbox/outbox-date-range.js';
import { OutboxTable } from '../src/components/outbox-table.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedOutbox() {
  const organisationId = randomUUID();
  const foreignOrganisationId = randomUUID();
  const actorUserId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  await client.db.insert(organisations).values([
    {
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Outbox organisation',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    },
    {
      id: foreignOrganisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Foreign organisation',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    }
  ]);
  await client.db.insert(users).values({
    id: actorUserId,
    cognitoSubject: randomUUID(),
    email: `${actorUserId}@example.invalid`,
    displayName: 'Avery Admin'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Acme Kitchens'
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: 'INV-100',
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '250',
    currency: 'AUD',
    syncVersion: 1
  });

  const idPrefix = randomUUID().slice(0, 24);
  const ids = {
    test: `${idPrefix}000000000004`,
    xero: `${idPrefix}000000000003`,
    historical: `${idPrefix}000000000002`,
    manual: `${idPrefix}000000000001`,
    foreign: randomUUID()
  };
  const tiedAt = new Date('2026-09-28T03:01:00.000Z');
  await client.db.insert(outboundMessages).values([
    {
      id: ids.test,
      organisationId,
      actorUserId,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: '+61400000001',
      content: 'AccountPulse test content',
      contentHash: 'test-hash',
      status: 'DELIVERED',
      idempotencyKey: randomUUID(),
      createdAt: new Date('2026-09-28T03:03:00.000Z'),
      updatedAt: new Date('2026-09-28T03:04:00.000Z'),
      completedAt: new Date('2026-09-28T03:04:00.000Z')
    },
    {
      id: ids.xero,
      organisationId,
      contactId,
      invoiceId,
      actorUserId,
      channel: 'XERO_EMAIL',
      source: 'XERO_EMAIL',
      recipientKey: 'accounts@acme.invalid',
      content: 'Xero invoice email requested for INV-100',
      contentHash: 'xero-hash',
      status: 'ACCEPTED',
      idempotencyKey: randomUUID(),
      createdAt: new Date('2026-09-28T03:02:00.000Z'),
      updatedAt: new Date('2026-09-28T03:02:00.000Z')
    },
    {
      id: ids.historical,
      organisationId,
      contactId,
      invoiceId,
      channel: 'SMS',
      source: 'AUTOMATED_REMINDER',
      recipientKey: '+61400000002',
      content: null,
      status: 'FAILED',
      failureReason: 'PROVIDER_REJECTED',
      idempotencyKey: randomUUID(),
      createdAt: tiedAt,
      updatedAt: tiedAt
    },
    {
      id: ids.manual,
      organisationId,
      contactId,
      invoiceId,
      actorUserId,
      channel: 'SMS',
      source: 'MANUAL_REMINDER',
      recipientKey: '+61400000003',
      content: 'Manual reminder content',
      contentHash: 'manual-hash',
      status: 'ACCEPTED',
      idempotencyKey: randomUUID(),
      createdAt: tiedAt,
      updatedAt: tiedAt
    },
    {
      id: ids.foreign,
      organisationId: foreignOrganisationId,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: '+61499999999',
      content: 'FOREIGN SECRET MESSAGE',
      contentHash: 'foreign-hash',
      status: 'DELIVERED',
      idempotencyKey: randomUUID(),
      createdAt: new Date('2026-09-28T04:00:00.000Z'),
      updatedAt: new Date('2026-09-28T04:00:00.000Z')
    }
  ]);
  await client.db.insert(messageAttempts).values({
    organisationId,
    outboundMessageId: ids.test,
    attemptNumber: 1,
    provider: 'SINCH',
    providerMessageId: 'sinch-outbox-1',
    status: 'DELIVERED',
    requestDispatchedAt: new Date('2026-09-28T03:03:00.000Z'),
    responseReceivedAt: new Date('2026-09-28T03:04:00.000Z')
  });

  return {
    organisationId,
    foreignOrganisationId,
    actorUserId,
    contactId,
    invoiceId,
    ids
  };
}

describe('Outbox query and presentation', () => {
  it('uses whole local Sydney days for date filters across standard and daylight time', () => {
    expect(
      parseOutboxDateRange({
        from: '2026-09-28',
        to: '2026-09-28',
        timeZone: 'Australia/Sydney'
      })
    ).toEqual({
      from: new Date('2026-09-27T14:00:00.000Z'),
      before: new Date('2026-09-28T14:00:00.000Z')
    });
    expect(
      parseOutboxDateRange({
        from: '2026-01-15',
        to: '2026-01-15',
        timeZone: 'Australia/Sydney'
      })
    ).toEqual({
      from: new Date('2026-01-14T13:00:00.000Z'),
      before: new Date('2026-01-15T13:00:00.000Z')
    });
    expect(
      parseOutboxDateRange({
        from: 'not-a-date',
        timeZone: 'Australia/Sydney'
      })
    ).toEqual({});
    expect(
      parseOutboxDateRange({
        from: '2026-09-28',
        to: '2026-02-31',
        timeZone: 'Australia/Sydney'
      })
    ).toEqual({
      from: new Date('2026-09-27T14:00:00.000Z')
    });
  });

  it('isolates organisations and uses a stable created-time plus ID cursor', async () => {
    const seeded = await seedOutbox();
    const first = await queryOutbox(client.db, {
      organisationId: seeded.organisationId,
      limit: 2
    });
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) throw new Error('Expected another page');
    const second = await queryOutbox(client.db, {
      organisationId: seeded.organisationId,
      cursor: first.nextCursor,
      limit: 2
    });

    expect(first.rows.map((row) => row.id)).toEqual([
      seeded.ids.test,
      seeded.ids.xero
    ]);
    expect(second.rows.map((row) => row.id)).toEqual([
      seeded.ids.historical,
      seeded.ids.manual
    ]);
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify([...first.rows, ...second.rows])).not.toContain(
      'FOREIGN SECRET MESSAGE'
    );
    expect(JSON.stringify([...first.rows, ...second.rows])).not.toContain(
      seeded.ids.foreign
    );
  });

  it('filters by source, channel, status, date, client, invoice, and recipient', async () => {
    const seeded = await seedOutbox();
    const filtered = await queryOutbox(client.db, {
      organisationId: seeded.organisationId,
      source: 'XERO_EMAIL',
      channel: 'XERO_EMAIL',
      status: 'ACCEPTED',
      from: new Date('2026-09-28T03:02:00.000Z'),
      before: new Date('2026-09-28T03:02:00.001Z'),
      search: 'INV-100',
      limit: 20
    });
    expect(filtered.rows.map((row) => row.id)).toEqual([seeded.ids.xero]);

    const clientSearch = await queryOutbox(client.db, {
      organisationId: seeded.organisationId,
      search: 'Acme Kitchens',
      limit: 20
    });
    expect(clientSearch.rows.map((row) => row.id)).toEqual([
      seeded.ids.xero,
      seeded.ids.historical,
      seeded.ids.manual
    ]);

    const recipientSearch = await queryOutbox(client.db, {
      organisationId: seeded.organisationId,
      search: '+61400000001',
      limit: 20
    });
    expect(recipientSearch.rows.map((row) => row.id)).toEqual([
      seeded.ids.test
    ]);
  });

  it('shows safe content fallbacks, provider results, and organisation-safe links', async () => {
    const seeded = await seedOutbox();
    const result = await queryOutbox(client.db, {
      organisationId: seeded.organisationId,
      limit: 20
    });
    const html = renderToStaticMarkup(createElement(OutboxTable, { rows: result.rows }));

    expect(html).toContain('Content was not retained for this historical message');
    expect(html).toContain('Xero controls the rendered email body');
    expect(html).toContain('Xero invoice email requested for INV-100');
    expect(html).toContain('sinch-outbox-1');
    expect(html).toContain(`/customers/${seeded.contactId}`);
    expect(html).toContain(`/invoices/${seeded.invoiceId}`);
    expect(html).not.toContain(seeded.foreignOrganisationId);
    expect(html).not.toContain('FOREIGN SECRET MESSAGE');
  });
});
