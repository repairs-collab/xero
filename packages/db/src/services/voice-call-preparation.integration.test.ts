import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { PostgresVoiceCallRepository } from '../repositories/voice-call-repository.js';
import {
  contactChannels,
  contacts,
  disputes,
  invoiceChases,
  invoices,
  organisations,
  organisationVoiceSettings,
  paymentPromises,
  reminderSequenceVersions,
  reminderSequences,
  reminderWhitelistEntries,
  suppressions,
  users
} from '../schema/index.js';
import {
  createVoicePreparationService,
  type VoicePreparationInput
} from './voice-call-preparation.js';

const database = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-10-08T00:00:00.000Z');

beforeAll(async () => migrateDatabase(database.db));
afterAll(async () => database.pool.end());

async function seedPreparationFixture() {
  const organisationId = randomUUID();
  const actorUserId = randomUUID();
  const customerId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const invoiceIds = [randomUUID(), randomUUID()];

  await database.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Preparation Test Organisation',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true,
    operationalState: 'READY',
    lastSuccessfulSyncAt: new Date('2026-10-07T23:45:00.000Z')
  });
  await database.db.insert(users).values({
    id: actorUserId,
    cognitoSubject: randomUUID(),
    email: `${actorUserId}@example.invalid`,
    displayName: 'Preparation operator'
  });
  await database.db.insert(contacts).values({
    id: customerId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Preparation Customer',
    active: true
  });
  await database.db.insert(contactChannels).values({
    organisationId,
    contactId: customerId,
    kind: 'VOICE',
    sourceValue: '0412 345 678',
    normalisedValue: '+61412345678',
    usable: true
  });
  await database.db.insert(organisationVoiceSettings).values({
    organisationId,
    enabled: true,
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
    updatedAt: new Date('2026-10-07T23:30:00.000Z')
  });
  await database.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Preparation voice ${sequenceId}`,
    kind: 'VOICE',
    mode: 'REVIEW',
    enabled: true
  });
  await database.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {}
  });
  await database.db.insert(invoices).values(
    invoiceIds.map((id, index) => ({
      id,
      organisationId,
      xeroInvoiceId: `xero-${id}`,
      contactId: customerId,
      invoiceNumber: `INV-${index + 1}`,
      type: 'ACCREC' as const,
      status: 'AUTHORISED' as const,
      issueDate: '2026-08-01',
      dueDate: index === 0 ? '2026-08-31' : '2026-09-07',
      amountDue: index === 0 ? '100.0000' : '25.5000',
      total: index === 0 ? '100.0000' : '25.5000',
      currency: 'AUD',
      syncVersion: index + 10
    }))
  );
  await database.db.insert(invoiceChases).values(
    invoiceIds.map((invoiceId) => ({
      organisationId,
      invoiceId,
      sequenceId,
      customerId,
      status: 'ACTIVE' as const
    }))
  );

  const repository = new PostgresVoiceCallRepository(database.db);
  const service = createVoicePreparationService({
    database: database.db,
    repository,
    clock: { now: () => now },
    holidays: { list: () => [] }
  });
  const manualInput: VoicePreparationInput = {
    organisationId,
    customerId,
    actorUserId,
    idempotencyKey: `manual-${randomUUID()}`,
    initialState: 'DRAFT',
    source: { kind: 'MANUAL' }
  };

  return {
    organisationId,
    actorUserId,
    customerId,
    sequenceId,
    sequenceVersionId,
    invoiceIds,
    repository,
    service,
    manualInput
  };
}

describe('voice call preparation service', () => {
  it('gives manual and sequence callers the same eligibility decision and facts hash', async () => {
    const seeded = await seedPreparationFixture();
    const manual = await seeded.service.evaluate(seeded.manualInput);
    const sequence = await seeded.service.evaluate({
      ...seeded.manualInput,
      actorUserId: null,
      idempotencyKey: `sequence-review-${randomUUID()}`,
      invoiceIds: seeded.invoiceIds,
      source: {
        kind: 'SEQUENCE_REVIEW',
        sequenceId: seeded.sequenceId,
        sequenceVersionId: seeded.sequenceVersionId,
        stageKey: 'twenty-one-days',
        scheduledAt: new Date('2026-10-08T00:00:00.000Z'),
        localOccurrenceDate: '2026-10-08'
      }
    });

    expect(sequence.allowed).toBe(manual.allowed);
    expect(sequence.blockCode).toBe(manual.blockCode);
    expect(sequence.approvedFactsHash).toBe(manual.approvedFactsHash);
    expect(sequence.includedInvoices).toEqual(manual.includedInvoices);
  });

  it('stores every sequence invoice once with exact source metadata', async () => {
    const seeded = await seedPreparationFixture();
    const scheduledAt = new Date('2026-10-08T00:00:00.000Z');
    const created = await seeded.service.create({
      ...seeded.manualInput,
      actorUserId: null,
      idempotencyKey: `sequence-automatic-${randomUUID()}`,
      initialState: 'APPROVED',
      invoiceIds: [
        seeded.invoiceIds[1] as string,
        seeded.invoiceIds[0] as string,
        seeded.invoiceIds[0] as string
      ],
      source: {
        kind: 'SEQUENCE_AUTOMATIC',
        sequenceId: seeded.sequenceId,
        sequenceVersionId: seeded.sequenceVersionId,
        stageKey: 'twenty-one-days',
        scheduledAt,
        localOccurrenceDate: '2026-10-08'
      }
    });
    if (created.voiceCallId === null) throw new Error('Expected a call');
    const stored = await seeded.repository.loadForExecution(
      seeded.organisationId,
      created.voiceCallId
    );

    expect(stored).toMatchObject({
      state: 'APPROVED',
      source: 'SEQUENCE_AUTOMATIC',
      sequenceId: seeded.sequenceId,
      sequenceVersionId: seeded.sequenceVersionId,
      stageKey: 'twenty-one-days',
      scheduledAt,
      localOccurrenceDate: '2026-10-08'
    });
    expect(stored?.approvedFactsHash).toBe(created.approvedFactsHash);
    expect(stored?.invoices.map((invoice) => invoice.invoiceId).sort()).toEqual(
      [...seeded.invoiceIds].sort()
    );
  });

  const blockedCases: Array<{
    name: string;
    expected: string;
    mutate: (
      seeded: Awaited<ReturnType<typeof seedPreparationFixture>>
    ) => Promise<unknown>;
  }> = [
    {
      name: 'invalid phone',
      expected: 'INVALID_DESTINATION',
      mutate: (seeded) =>
        database.db
          .update(contactChannels)
          .set({ normalisedValue: '+61000000000' })
          .where(eq(contactChannels.contactId, seeded.customerId))
    },
    {
      name: 'voice suppression',
      expected: 'VOICE_SUPPRESSED',
      mutate: (seeded) =>
        database.db.insert(suppressions).values({
          organisationId: seeded.organisationId,
          channel: 'VOICE',
          normalisedDestination: '+61412345678',
          source: 'WRONG_PERSON',
          reason: 'Wrong person reported',
          consentState: 'SUPPRESSED'
        })
    },
    {
      name: 'client whitelist',
      expected: 'WHITELISTED',
      mutate: (seeded) =>
        database.db.insert(reminderWhitelistEntries).values({
          organisationId: seeded.organisationId,
          scope: 'CLIENT',
          contactId: seeded.customerId,
          reason: 'Customer excluded'
        })
    },
    {
      name: 'open account dispute',
      expected: 'DISPUTE_OPEN',
      mutate: (seeded) =>
        database.db.insert(disputes).values({
          organisationId: seeded.organisationId,
          contactId: seeded.customerId,
          status: 'OPEN',
          reason: 'Account disputed'
        })
    },
    {
      name: 'active promise',
      expected: 'PROMISE_ACTIVE',
      mutate: (seeded) =>
        database.db.insert(paymentPromises).values({
          organisationId: seeded.organisationId,
          contactId: seeded.customerId,
          promisedDate: '2026-10-20',
          graceDays: 2,
          status: 'ACTIVE'
        })
    },
    {
      name: 'stale organisation state',
      expected: 'STALE_ACCOUNT_DATA',
      mutate: (seeded) =>
        database.db
          .update(organisations)
          .set({ operationalState: 'SYNC_REQUIRED' })
          .where(eq(organisations.id, seeded.organisationId))
    }
  ];

  it.each(blockedCases)('returns the established block code for $name', async ({
    expected,
    mutate
  }) => {
    const seeded = await seedPreparationFixture();
    await mutate(seeded);

    const result = await seeded.service.evaluate(seeded.manualInput);

    expect(result.allowed).toBe(false);
    expect(result.blockCode).toBe(expected);
  });
});
