import { randomUUID } from 'node:crypto';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthorizationFailure, type AppSession } from '@bc5000/auth';
import {
  contacts,
  createDatabase,
  invoices,
  migrateDatabase,
  organisations,
  users
} from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { ...props, href, children })
}));

import {
  buildReminderWhitelistSections,
  ReminderWhitelistControls,
  ReminderWhitelistSettingsList
} from '../src/components/reminder-whitelist-controls.js';
import { createReminderWhitelistService } from '../src/server/reminder-whitelist-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-28T04:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const publisher = () =>
  ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

async function seed() {
  const organisationId = randomUUID();
  const foreignOrganisationId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  await client.db.insert(organisations).values([
    {
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Whitelist UI',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    },
    {
      id: foreignOrganisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Foreign whitelist UI',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    }
  ]);
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Alex Operator'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Overlapping Client'
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: 'INV-WHITE-1',
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '125',
    currency: 'AUD',
    syncVersion: 1
  });
  const session = (role: 'ADMIN' | 'OPERATOR'): AppSession => ({
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'Alex Operator',
    expiresAt: '2026-09-29T00:00:00.000Z',
    memberships: [{ organisationId, role, active: true }]
  });
  return {
    organisationId,
    foreignOrganisationId,
    userId,
    contactId,
    invoiceId,
    session
  };
}

describe('Reminder Whitelist interface', () => {
  it('requires confirmation for both stop scopes and preserves an optional reason', () => {
    const action = vi.fn<(_: FormData) => Promise<void>>(() => Promise.resolve());
    const html = renderToStaticMarkup(
      createElement(ReminderWhitelistControls, {
        organisationId: randomUUID(),
        contactId: randomUUID(),
        invoiceId: randomUUID(),
        action
      })
    );

    expect(html).toContain('Stop reminders for invoice');
    expect(html).toContain('Stop reminders for client');
    expect(html.match(/name="confirmed"/g)).toHaveLength(2);
    expect(html.match(/name="reason"/g)).toHaveLength(2);
    expect(html).toContain('Current and future reminders will stop immediately');
  });

  it('lists overlapping client and invoice entries separately with searchable details', async () => {
    const seeded = await seed();
    const service = createReminderWhitelistService({
      database: client.db,
      publisher: publisher(),
      clock: { now: () => now }
    });
    await service.add(seeded.session('OPERATOR'), {
      organisationId: seeded.organisationId,
      scope: 'CLIENT',
      contactId: seeded.contactId,
      reason: 'Client requested a hold'
    });
    await service.add(seeded.session('OPERATOR'), {
      organisationId: seeded.organisationId,
      scope: 'INVOICE',
      contactId: seeded.contactId,
      invoiceId: seeded.invoiceId,
      reason: 'Invoice is disputed'
    });

    const rows = await service.list(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId
    });
    const all = buildReminderWhitelistSections(rows, '');
    const invoiceSearch = buildReminderWhitelistSections(rows, 'INV-WHITE-1');
    expect(all.clients).toHaveLength(1);
    expect(all.invoices).toHaveLength(1);
    expect(invoiceSearch.clients).toHaveLength(0);
    expect(invoiceSearch.invoices).toHaveLength(1);

    const html = renderToStaticMarkup(
      createElement(ReminderWhitelistSettingsList, {
        organisationId: seeded.organisationId,
        sections: all,
        removeAction: () => Promise.resolve()
      })
    );
    expect(html).toContain('Client requested a hold');
    expect(html).toContain('Invoice is disputed');
    expect(html).toContain('Alex Operator');
    expect(html).toContain('28 Sept 2026');
    expect(html).toContain('Remove and resume chasing');
  });

  it('allows Operators to add, restricts removal to Administrators, and rejects foreign targets', async () => {
    const seeded = await seed();
    const service = createReminderWhitelistService({
      database: client.db,
      publisher: publisher(),
      clock: { now: () => now }
    });
    const added = await service.add(seeded.session('OPERATOR'), {
      organisationId: seeded.organisationId,
      scope: 'INVOICE',
      contactId: seeded.contactId,
      invoiceId: seeded.invoiceId
    });
    await expect(
      service.remove(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        entryId: added.entryId
      })
    ).rejects.toBeInstanceOf(AuthorizationFailure);
    await expect(
      service.add(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        scope: 'CLIENT',
        contactId: randomUUID()
      })
    ).rejects.toThrow('REMINDER_WHITELIST_TARGET_NOT_FOUND');
    await expect(
      service.remove(
        {
          ...seeded.session('ADMIN'),
          memberships: [
            {
              organisationId: seeded.foreignOrganisationId,
              role: 'ADMIN',
              active: true
            }
          ]
        },
        {
          organisationId: seeded.foreignOrganisationId,
          entryId: added.entryId
        }
      )
    ).rejects.toThrow('REMINDER_WHITELIST_ENTRY_NOT_FOUND');
    await expect(
      service.remove(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        entryId: added.entryId
      })
    ).resolves.toMatchObject({ removed: true });
  });
});
