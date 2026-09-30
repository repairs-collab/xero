import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  contactChannels,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  memberships,
  migrateDatabase,
  organisations,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages,
  suppressions,
  users
} from '@bc5000/db';

import { createSmsIssueService } from '../src/app/(protected)/sms-issues/sms-issue-service.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

const seedInvoice = async (options: {
  channel?: string;
  channelUsable?: boolean;
  sequenceEnabled?: boolean;
  chaseStatus?: 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'COMPLETED';
  invoiceStatus?: 'AUTHORISED' | 'PAID';
  stageChannel?: 'SMS' | 'SMS_DAILY' | 'XERO_EMAIL';
}) => {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    name: 'SMS issue test organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `operator-${userId}@example.invalid`,
    displayName: 'SMS Operator'
  });
  await client.db.insert(memberships).values({
    organisationId,
    userId,
    role: 'OPERATOR'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Alex Customer',
    active: true,
    email: 'alex@example.invalid'
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: 'INV-5000',
    type: 'ACCREC',
    status: options.invoiceStatus ?? 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: options.invoiceStatus === 'PAID' ? '0' : '125.5000',
    currency: 'AUD',
    syncVersion: 1
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `SMS issue sequence ${sequenceId}`,
    mode: 'AUTOMATIC',
    enabled: options.sequenceEnabled ?? true
  });
  await client.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE'
  });
  await client.db.insert(sequenceStages).values({
    organisationId,
    sequenceVersionId,
    stageKey: 'due-date',
    offsetDays: 0,
    channel: options.stageChannel ?? 'SMS',
    template: 'Invoice {{invoice_number}} is due.'
  });
  await client.db.insert(invoiceChases).values({
    organisationId,
    invoiceId,
    sequenceId,
    customerId: contactId,
    status: options.chaseStatus ?? 'ACTIVE'
  });
  if (options.channel !== undefined) {
    await client.db.insert(contactChannels).values({
      organisationId,
      contactId,
      kind: 'SMS',
      sourceValue: options.channel,
      normalisedValue: options.channel,
      usable: options.channelUsable ?? true
    });
  }
  const session: AppSession = {
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'SMS Operator',
    expiresAt: '2026-10-01T12:00:00.000Z',
    memberships: [{ organisationId, role: 'OPERATOR', active: true }]
  };
  return { organisationId, contactId, invoiceId, session };
};

describe('SMS issue service', () => {
  it('lists an actively chased invoice when its customer has no usable mobile', async () => {
    const seeded = await seedInvoice({});
    const service = createSmsIssueService({ database: client.db });

    await expect(
      service.list(seeded.session, {
        organisationId: seeded.organisationId
      })
    ).resolves.toEqual({
      contactDetailsNeeded: [
        {
          customerId: seeded.contactId,
          customerName: 'Alex Customer',
          email: 'alex@example.invalid',
          reason: 'NO_USABLE_MOBILE',
          destination: null,
          invoices: [
            {
              id: seeded.invoiceId,
              invoiceNumber: 'INV-5000',
              amountDue: '125.5000',
              currency: 'AUD',
              dueDate: '2026-08-31'
            }
          ]
        }
      ],
      complianceBlocked: []
    });
  });

  it('moves a customer from contact details needed to compliance blocked when the selected number is suppressed', async () => {
    const phone = '+61400000001';
    const seeded = await seedInvoice({ channel: phone });
    await client.db.insert(suppressions).values({
      organisationId: seeded.organisationId,
      channel: 'SMS',
      normalisedDestination: phone,
      source: 'CUSTOMER_REPLY',
      reason: 'STOP received',
      consentState: 'SUPPRESSED'
    });
    const service = createSmsIssueService({ database: client.db });

    const result = await service.list(seeded.session, {
      organisationId: seeded.organisationId
    });

    expect(result.contactDetailsNeeded).toEqual([]);
    expect(result.complianceBlocked).toEqual([
      expect.objectContaining({
        customerId: seeded.contactId,
        reason: 'SMS_SUPPRESSED',
        destination: phone
      })
    ]);
  });

  it('removes the issue as soon as a usable unsuppressed number exists', async () => {
    const seeded = await seedInvoice({});
    const service = createSmsIssueService({ database: client.db });
    await expect(
      service.list(seeded.session, { organisationId: seeded.organisationId })
    ).resolves.toMatchObject({ contactDetailsNeeded: [{ customerId: seeded.contactId }] });

    await client.db.insert(contactChannels).values({
      organisationId: seeded.organisationId,
      contactId: seeded.contactId,
      kind: 'SMS',
      sourceValue: '0400 000 001',
      normalisedValue: '+61400000001',
      usable: true,
      approvedOverride: true
    });

    await expect(
      service.list(seeded.session, { organisationId: seeded.organisationId })
    ).resolves.toEqual({ contactDetailsNeeded: [], complianceBlocked: [] });
  });

  it.each([
    ['paid invoices', { invoiceStatus: 'PAID' as const }],
    ['paused chases', { chaseStatus: 'PAUSED' as const }],
    ['disabled sequences', { sequenceEnabled: false }],
    ['sequences without SMS stages', { stageChannel: 'XERO_EMAIL' as const }]
  ])('does not report %s', async (_label, options) => {
    const seeded = await seedInvoice(options);
    const service = createSmsIssueService({ database: client.db });

    await expect(
      service.list(seeded.session, { organisationId: seeded.organisationId })
    ).resolves.toEqual({ contactDetailsNeeded: [], complianceBlocked: [] });
  });
});
