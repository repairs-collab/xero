import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  approvals,
  contactChannels,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  organisations,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages,
  stageInstances,
  suppressions,
  tasks
} from '@bc5000/db';

import { calculateReminderWork } from '../src/handlers/reminders-calculate.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const now = new Date('2026-09-18T00:00:00.000Z');
const unusedXero = {
  getOnlineInvoiceUrl: () =>
    Promise.reject(new Error('Online invoice URL was not expected'))
};

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

const seedInvoiceAndSequence = async (options: {
  mode: 'REVIEW' | 'AUTOMATIC';
  dueDate: string;
  offsetDays: number;
  channel: 'SMS' | 'XERO_EMAIL' | 'TASK' | 'SMS_DAILY';
  onlineInvoiceUrl?: string | null;
  template?: string;
}) => {
  const organisationId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();

  await client.db.insert(organisations).values({
    id: organisationId,
    name: 'Calculation Test Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Alex Customer',
    active: true,
    email: 'accounts@example.invalid'
  });
  await client.db.insert(contactChannels).values({
    organisationId,
    contactId,
    kind: 'SMS',
    sourceValue: '0400 000 001',
    normalisedValue: '+61400000001',
    usable: true
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: 'INV-5000',
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: options.dueDate,
    amountDue: '125.5000',
    currency: 'AUD',
    onlineInvoiceUrl:
      options.onlineInvoiceUrl === undefined
        ? 'https://in.xero.test/INV-5000'
        : options.onlineInvoiceUrl,
    syncVersion: 3,
    updatedAt: now
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Sequence ${sequenceId}`,
    mode: options.mode
  });
  await client.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {}
  });
  await client.db.insert(sequenceStages).values({
    organisationId,
    sequenceVersionId,
    stageKey: options.offsetDays === 30 ? 'thirty-days' : 'due-date',
    offsetDays: options.offsetDays,
    channel: options.channel,
    template:
      options.channel === 'SMS' || options.channel === 'SMS_DAILY'
        ? (options.template ??
          'Hi {{customer_name}}, invoice {{invoice_number}} for {{amount_due}} {{currency}} is due. {{online_invoice_url}}')
        : null
  });

  return {
    organisationId,
    contactId,
    invoiceId,
    sequenceId,
    sequenceVersionId
  };
};

describe('calculateReminderWork', () => {
  it('fetches and caches a missing URL before creating a review SMS preview', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS',
      onlineInvoiceUrl: null
    });
    const staleUpdatedAt = new Date('2026-09-17T22:00:00.000Z');
    await client.db
      .update(invoices)
      .set({ updatedAt: staleUpdatedAt })
      .where(eq(invoices.id, seeded.invoiceId));
    const getOnlineInvoiceUrl = vi.fn(() =>
      Promise.resolve({
        data: 'https://in.xero.test/fetched-link',
        rateLimit: {
          limit: 60,
          remaining: 59,
          dailyRemaining: 999,
          problem: null,
          retryAfterSeconds: null
        }
      })
    );

    await calculateReminderWork(
      {
        database: client.db,
        clock: { now: () => now },
        xero: { getOnlineInvoiceUrl }
      },
      seeded.organisationId
    );

    expect(getOnlineInvoiceUrl).toHaveBeenCalledOnce();
    const [storedInvoice] = await client.db
      .select({
        onlineInvoiceUrl: invoices.onlineInvoiceUrl,
        updatedAt: invoices.updatedAt
      })
      .from(invoices)
      .where(eq(invoices.id, seeded.invoiceId));
    expect(storedInvoice?.onlineInvoiceUrl).toBe(
      'https://in.xero.test/fetched-link'
    );
    expect(storedInvoice?.updatedAt).toEqual(staleUpdatedAt);
    const [approval] = await client.db
      .select({ renderedPreview: approvals.renderedPreview })
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    expect(approval?.renderedPreview).toContain(
      'https://in.xero.test/fetched-link'
    );
  });

  it('does not create a stage when fetching a required preview URL fails', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS',
      onlineInvoiceUrl: null
    });
    const failure = new Error('Xero rate limited');

    await expect(
      calculateReminderWork(
        {
          database: client.db,
          clock: { now: () => now },
          xero: {
            getOnlineInvoiceUrl: () => Promise.reject(failure)
          }
        },
        seeded.organisationId
      )
    ).rejects.toBe(failure);

    const stages = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, seeded.organisationId));
    const approvalRows = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    expect(stages).toHaveLength(0);
    expect(approvalRows).toHaveLength(0);
  });

  it('does not fetch a URL when the review SMS template does not use it', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS',
      onlineInvoiceUrl: null,
      template: 'Hi {{customer_name}}, invoice {{invoice_number}} is due.'
    });
    const getOnlineInvoiceUrl = vi.fn();

    await calculateReminderWork(
      {
        database: client.db,
        clock: { now: () => now },
        xero: { getOnlineInvoiceUrl }
      },
      seeded.organisationId
    );

    expect(getOnlineInvoiceUrl).not.toHaveBeenCalled();
  });

  it('creates an exact pending preview for a review-mode SMS', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS'
    });

    const summary = await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    expect(summary).toMatchObject({ createdStages: 1, createdApprovals: 1 });
    const [stage] = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, seeded.organisationId));
    expect(stage?.status).toBe('AWAITING_APPROVAL');
    const [approval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.stageInstanceId, stage?.id ?? randomUUID()));
    expect(approval).toMatchObject({
      status: 'PENDING',
      sourceVersion: 3,
      renderedPreview:
        'Hi Alex Customer, invoice INV-5000 for 125.5000 AUD is due. https://in.xero.test/INV-5000'
    });
  });

  it('creates one automatic daily SMS occurrence and one escalation task at day 30', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'AUTOMATIC',
      dueDate: '2026-08-19',
      offsetDays: 30,
      channel: 'SMS_DAILY'
    });

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );
    const second = await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    const stages = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, seeded.organisationId));
    expect(stages).toHaveLength(1);
    expect(stages[0]?.status).toBe('SCHEDULED');
    const escalationTasks = await client.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.organisationId, seeded.organisationId),
          eq(tasks.kind, 'DEBT_ESCALATION')
        )
      );
    expect(escalationTasks).toHaveLength(1);
    expect(second).toMatchObject({
      createdStages: 0,
      createdApprovals: 0,
      createdTasks: 0
    });
    const [chase] = await client.db
      .select()
      .from(invoiceChases)
      .where(eq(invoiceChases.invoiceId, seeded.invoiceId));
    expect(chase?.sequenceId).toBe(seeded.sequenceId);
  });

  it('expires historical pending daily reminders while preserving the current review item', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-08-01',
      offsetDays: 30,
      channel: 'SMS_DAILY'
    });

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );
    const [chase] = await client.db
      .select()
      .from(invoiceChases)
      .where(eq(invoiceChases.invoiceId, seeded.invoiceId));
    if (chase === undefined) throw new Error('Expected an invoice chase');

    for (const scheduledAt of [
      new Date('2026-09-15T23:00:00.000Z'),
      new Date('2026-09-16T23:00:00.000Z')
    ]) {
      const stageId = randomUUID();
      await client.db.insert(stageInstances).values({
        id: stageId,
        organisationId: seeded.organisationId,
        invoiceChaseId: chase.id,
        sequenceVersionId: seeded.sequenceVersionId,
        stageKey: 'daily-after-30',
        channel: 'SMS',
        status: 'AWAITING_APPROVAL',
        scheduledAt,
        sourceVersion: 3
      });
      await client.db.insert(approvals).values({
        organisationId: seeded.organisationId,
        stageInstanceId: stageId,
        renderedPreview: 'Historical reminder',
        sourceVersion: 3,
        status: 'PENDING',
        expiresAt: new Date('2026-09-19T00:00:00.000Z')
      });
    }

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    const approvalRows = await client.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    const stageRows = await client.db
      .select({ status: stageInstances.status })
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, seeded.organisationId));
    expect(approvalRows.filter((row) => row.status === 'PENDING')).toHaveLength(1);
    expect(approvalRows.filter((row) => row.status === 'EXPIRED')).toHaveLength(2);
    expect(stageRows.filter((row) => row.status === 'AWAITING_APPROVAL')).toHaveLength(1);
    expect(stageRows.filter((row) => row.status === 'CANCELLED')).toHaveLength(2);
  });

  it('expires pending reminders when the invoice falls below the sequence minimum', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS'
    });
    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );
    await client.db
      .update(reminderSequenceVersions)
      .set({ minimumBalance: '500.0000' })
      .where(eq(reminderSequenceVersions.id, seeded.sequenceVersionId));

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    const [approval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    expect(approval?.status).toBe('EXPIRED');
  });

  it('expires current-date reminders when their channel becomes unusable', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS'
    });
    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );
    await client.db
      .update(contactChannels)
      .set({ usable: false })
      .where(eq(contactChannels.contactId, seeded.contactId));

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    const [approval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    expect(approval?.status).toBe('EXPIRED');
  });

  it('expires current-date SMS reminders after the customer opts out', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS'
    });
    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );
    await client.db.insert(suppressions).values({
      organisationId: seeded.organisationId,
      channel: 'SMS',
      normalisedDestination: '+61400000001',
      source: 'SINCH_OPT_OUT',
      reason: 'Customer opted out',
      consentState: 'SUPPRESSED'
    });

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    const [approval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    expect(approval?.status).toBe('EXPIRED');
  });

  it('expires pending reminders from an inactive sequence version', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS'
    });
    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );
    const [chase] = await client.db
      .select()
      .from(invoiceChases)
      .where(eq(invoiceChases.invoiceId, seeded.invoiceId));
    if (chase === undefined) throw new Error('Expected an invoice chase');
    const retiredVersionId = randomUUID();
    await client.db.insert(reminderSequenceVersions).values({
      id: retiredVersionId,
      organisationId: seeded.organisationId,
      sequenceId: seeded.sequenceId,
      versionNumber: 2,
      status: 'RETIRED',
      configuration: {}
    });
    const retiredStageId = randomUUID();
    await client.db.insert(stageInstances).values({
      id: retiredStageId,
      organisationId: seeded.organisationId,
      invoiceChaseId: chase.id,
      sequenceVersionId: retiredVersionId,
      stageKey: 'due-date',
      channel: 'SMS',
      status: 'AWAITING_APPROVAL',
      scheduledAt: new Date('2026-09-16T23:00:00.000Z'),
      sourceVersion: 3
    });
    await client.db.insert(approvals).values({
      organisationId: seeded.organisationId,
      stageInstanceId: retiredStageId,
      renderedPreview: 'Retired version reminder',
      sourceVersion: 3,
      status: 'PENDING',
      expiresAt: new Date('2026-09-19T00:00:00.000Z')
    });

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    const [retiredApproval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.stageInstanceId, retiredStageId));
    expect(retiredApproval?.status).toBe('EXPIRED');
  });

  it('expires an approval whose review window elapsed', async () => {
    const seeded = await seedInvoiceAndSequence({
      mode: 'REVIEW',
      dueDate: '2026-09-18',
      offsetDays: 0,
      channel: 'SMS'
    });
    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );
    await client.db
      .update(approvals)
      .set({ expiresAt: new Date(now.getTime() - 1) })
      .where(eq(approvals.organisationId, seeded.organisationId));

    await calculateReminderWork(
      { database: client.db, clock: { now: () => now }, xero: unusedXero },
      seeded.organisationId
    );

    const [approval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    const [stage] = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, seeded.organisationId));
    expect(approval?.status).toBe('EXPIRED');
    expect(stage?.status).toBe('CANCELLED');
  });
});
