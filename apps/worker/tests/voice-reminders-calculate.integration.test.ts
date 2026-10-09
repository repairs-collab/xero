import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contactChannels,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  organisations,
  organisationVoiceSettings,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages,
  stageInstances,
  tasks,
  voiceCallInvoices,
  voiceCallRequests
} from '@bc5000/db';

import { calculateReminderWork } from '../src/handlers/reminders-calculate.js';
import { calculateVoiceReminderWork } from '../src/handlers/voice-reminders-calculate.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-10-09T00:30:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

interface SeedOptions {
  mode?: 'REVIEW' | 'AUTOMATIC';
  enabled?: boolean;
  versionStatus?: 'ACTIVE' | 'RETIRED';
  kind?: 'MESSAGING' | 'VOICE';
  customerCount?: number;
  invoicesPerCustomer?: number;
  phone?: 'valid' | 'missing' | 'invalid';
}

async function seedVoiceCalculation(options: SeedOptions = {}) {
  const organisationId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const customerIds = Array.from(
    { length: options.customerCount ?? 1 },
    () => randomUUID()
  );
  const invoiceIds: string[] = [];

  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: `Voice calculation ${organisationId}`,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true,
    operationalState: 'READY',
    lastSuccessfulSyncAt: new Date('2026-10-09T00:15:00.000Z')
  });
  await client.db.insert(organisationVoiceSettings).values({
    organisationId,
    enabled: true,
    automaticEnabled: false,
    provider: 'VOIPCLOUD',
    agentId: 'agent-accountpulse',
    agentVersion: 7,
    voiceId: 'voice-au-1',
    voipcloudUserNumber: '1099',
    ttsVoiceId: 'en_GB-alba-medium',
    gatewayFlowVersion: 1,
    outboundNumber: '+61255501234',
    fallbackOfficeNumber: '+61350324518',
    officeDestinationLabel: 'Main office accounts queue',
    timezone: 'Australia/Sydney',
    weekdayStartLocal: '09:00',
    weekdayEndLocal: '17:00',
    updatedAt: new Date('2026-10-09T00:10:00.000Z')
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Sequence ${sequenceId}`,
    kind: options.kind ?? 'VOICE',
    mode: options.mode ?? 'REVIEW',
    enabled: options.enabled ?? true
  });
  await client.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: options.versionStatus ?? 'ACTIVE',
    dailyBasis: 'CALENDAR_DAYS',
    sendTime: '11:00:00',
    socialWindowStart: '09:00:00',
    socialWindowEnd: '17:00:00',
    minimumBalance: '0',
    configuration: {
      allowedCurrencies: ['AUD'],
      maxCallsPerRun: 5,
      cooldownSeconds: 120
    }
  });
  await client.db.insert(sequenceStages).values({
    organisationId,
    sequenceVersionId,
    stageKey: 'twenty-one-days-voice',
    offsetDays: 21,
    channel: options.kind === 'MESSAGING' ? 'SMS' : 'VOICE',
    template:
      options.kind === 'MESSAGING'
        ? 'Invoice {{invoice_number}} is overdue.'
        : null
  });

  for (const [customerIndex, customerId] of customerIds.entries()) {
    await client.db.insert(contacts).values({
      id: customerId,
      organisationId,
      xeroContactId: randomUUID(),
      name: `Customer ${customerIndex + 1}`,
      active: true
    });
    if (options.phone !== 'missing') {
      await client.db.insert(contactChannels).values({
        organisationId,
        contactId: customerId,
        kind: 'VOICE',
        sourceValue:
          options.phone === 'invalid' ? 'not a phone' : '0412 345 678',
        normalisedValue:
          options.phone === 'invalid' ? '+61000000000' : '+61412345678',
        usable: true
      });
    }
    for (
      let invoiceIndex = 0;
      invoiceIndex < (options.invoicesPerCustomer ?? 1);
      invoiceIndex += 1
    ) {
      const invoiceId = randomUUID();
      invoiceIds.push(invoiceId);
      await client.db.insert(invoices).values({
        id: invoiceId,
        organisationId,
        xeroInvoiceId: `xero-${invoiceId}`,
        contactId: customerId,
        invoiceNumber: `INV-${customerIndex + 1}-${invoiceIndex + 1}`,
        type: 'ACCREC',
        status: 'AUTHORISED',
        issueDate: '2026-08-01',
        dueDate: '2026-09-18',
        amountDue: invoiceIndex === 0 ? '100.0000' : '25.5000',
        total: invoiceIndex === 0 ? '100.0000' : '25.5000',
        currency: 'AUD',
        syncVersion: invoiceIndex + 1
      });
    }
  }

  return {
    organisationId,
    sequenceId,
    sequenceVersionId,
    customerIds,
    invoiceIds
  };
}

const dependencies = {
  database: client.db,
  clock: { now: () => now },
  holidays: { list: () => [] }
};

describe('calculateVoiceReminderWork', () => {
  it('creates one review call with every customer invoice and stays idempotent under concurrent runs', async () => {
    const seeded = await seedVoiceCalculation({ invoicesPerCustomer: 2 });

    await Promise.all([
      calculateVoiceReminderWork(dependencies, seeded.organisationId),
      calculateVoiceReminderWork(dependencies, seeded.organisationId)
    ]);

    const calls = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.organisationId, seeded.organisationId));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      state: 'DRAFT',
      source: 'SEQUENCE_REVIEW',
      sequenceId: seeded.sequenceId,
      sequenceVersionId: seeded.sequenceVersionId,
      stageKey: 'twenty-one-days-voice',
      localOccurrenceDate: '2026-10-09',
      combinedAmount: '125.5000'
    });
    const snapshots = await client.db
      .select()
      .from(voiceCallInvoices)
      .where(eq(voiceCallInvoices.voiceCallId, calls[0]!.id));
    expect(snapshots.map((snapshot) => snapshot.invoiceId).sort()).toEqual(
      [...seeded.invoiceIds].sort()
    );
    const chases = await client.db
      .select()
      .from(invoiceChases)
      .where(eq(invoiceChases.sequenceId, seeded.sequenceId));
    expect(chases).toHaveLength(2);
  });

  it('creates approved automatic calls but never publishes provider work', async () => {
    const seeded = await seedVoiceCalculation({ mode: 'AUTOMATIC' });

    const summary = await calculateVoiceReminderWork(
      dependencies,
      seeded.organisationId
    );
    const [call] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.organisationId, seeded.organisationId));

    expect(call).toMatchObject({
      state: 'APPROVED',
      source: 'SEQUENCE_AUTOMATIC'
    });
    expect(summary).toMatchObject({ preparedCalls: 1, approvedCalls: 1 });
  });

  it('keeps different customers in separate consolidated calls', async () => {
    const seeded = await seedVoiceCalculation({
      customerCount: 2,
      invoicesPerCustomer: 2
    });

    await calculateVoiceReminderWork(dependencies, seeded.organisationId);
    const calls = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.organisationId, seeded.organisationId));

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.contactId))).toEqual(
      new Set(seeded.customerIds)
    );
  });

  it.each([
    ['disabled sequence', { enabled: false }],
    ['retired version', { versionStatus: 'RETIRED' as const }]
  ])('ignores a %s', async (_label, options) => {
    const seeded = await seedVoiceCalculation(options);

    await calculateVoiceReminderWork(dependencies, seeded.organisationId);
    const calls = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.organisationId, seeded.organisationId));

    expect(calls).toHaveLength(0);
  });

  it.each(['missing', 'invalid'] as const)(
    'creates one contact-review task for a %s phone number',
    async (phone) => {
      const seeded = await seedVoiceCalculation({ phone });

      await Promise.all([
        calculateVoiceReminderWork(dependencies, seeded.organisationId),
        calculateVoiceReminderWork(dependencies, seeded.organisationId)
      ]);
      const reviewTasks = await client.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.organisationId, seeded.organisationId),
            eq(tasks.kind, 'VOICE_CONTACT_REVIEW'),
            eq(tasks.status, 'OPEN')
          )
        );

      expect(reviewTasks).toHaveLength(1);
      expect(reviewTasks[0]).toMatchObject({
        contactId: seeded.customerIds[0],
        sequenceId: seeded.sequenceId
      });
    }
  );

  it('keeps the messaging calculator away from voice sequences', async () => {
    const seeded = await seedVoiceCalculation();

    const result = await calculateReminderWork(
      {
        database: client.db,
        clock: { now: () => now },
        xero: {
          getOnlineInvoiceUrl: () =>
            Promise.reject(new Error('Voice sequence must not reach Xero'))
        }
      },
      seeded.organisationId
    );
    const calculatedMessagingStages = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, seeded.organisationId));

    expect(result.createdStages).toBe(0);
    expect(calculatedMessagingStages).toHaveLength(0);
  });

  it('ignores messaging sequences in the voice calculator', async () => {
    const seeded = await seedVoiceCalculation({ kind: 'MESSAGING' });

    await calculateVoiceReminderWork(dependencies, seeded.organisationId);
    const calls = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.organisationId, seeded.organisationId));

    expect(calls).toHaveLength(0);
  });
});
