import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
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
  users,
  voiceCallInvoices,
  voiceCallRequests
} from '@bc5000/db';
import { PostgresVoiceCallRepository } from '@bc5000/db';

import {
  buildApprovedVoiceFactsHash,
  createVoiceCallService
} from '../src/app/(protected)/customers/[customerId]/voice/voice-call-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-10-08T00:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seed() {
  const organisationId = randomUUID();
  const otherOrganisationId = randomUUID();
  const userId = randomUUID();
  const customerId = randomUUID();
  const otherCustomerId = randomUUID();
  const sequenceId = randomUUID();

  await client.db.insert(organisations).values([
    {
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Mott Appliance Repairs',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      sendMode: 'live',
      rolloutScope: 'CUSTOMER',
      liveSendAcknowledged: true,
      operationalState: 'READY',
      lastSuccessfulSyncAt: new Date('2026-10-07T23:45:00.000Z')
    },
    {
      id: otherOrganisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Other organisation',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    }
  ]);
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Voice Operator'
  });
  await client.db.insert(contacts).values([
    {
      id: customerId,
      organisationId,
      xeroContactId: randomUUID(),
      name: 'Example Customer',
      active: true,
      sourceVersion: 4
    },
    {
      id: otherCustomerId,
      organisationId: otherOrganisationId,
      xeroContactId: randomUUID(),
      name: 'Other Customer',
      active: true
    }
  ]);
  await client.db.insert(contactChannels).values({
    organisationId,
    contactId: customerId,
    kind: 'VOICE',
    sourceValue: '0412 345 678',
    normalisedValue: '+61412345678',
    usable: true
  });
  await client.db.insert(organisationVoiceSettings).values({
    organisationId,
    enabled: true,
    configurationVersion: 2,
    provider: 'RETELL',
    secretReference: 'env:RETELL_API_KEY',
    previewPublicKey: 'public_key_preview_only',
    agentId: 'agent_accountpulse',
    agentVersion: 7,
    voiceId: 'voice_au_1',
    voiceLabel: 'Australian accounts voice',
    voipcloudUserNumber: '1099',
    ttsVoiceId: 'en_GB-alba-medium',
    gatewayFlowVersion: 1,
    outboundNumber: '+61255501234',
    transferSipUri: 'sip:accounts@voipline.example',
    fallbackOfficeNumber: '+61255504321',
    officeDestinationLabel: 'Main office accounts queue',
    timezone: 'Australia/Sydney',
    weekdayStartLocal: '09:00',
    weekdayEndLocal: '17:00',
    lastConnectionTestedAt: now,
    lastConnectionTestSucceeded: true,
    updatedByUserId: userId,
    updatedAt: new Date('2026-10-07T23:30:00.000Z')
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Voice eligibility ${sequenceId}`,
    enabled: true
  });

  const invoiceInput = [
    {
      id: randomUUID(),
      invoiceNumber: 'INV-100',
      dueDate: '2026-09-10',
      amountDue: '100.0000',
      withChase: true
    },
    {
      id: randomUUID(),
      invoiceNumber: 'INV-200',
      dueDate: '2026-09-20',
      amountDue: '25.5000',
      withChase: true
    },
    {
      id: randomUUID(),
      invoiceNumber: 'INV-FUTURE',
      dueDate: '2026-10-20',
      amountDue: '40.0000',
      withChase: true
    },
    {
      id: randomUUID(),
      invoiceNumber: 'INV-NO-CHASE',
      dueDate: '2026-09-15',
      amountDue: '12.0000',
      withChase: false
    }
  ];
  await client.db.insert(invoices).values(
    invoiceInput.map((invoice, index) => ({
      id: invoice.id,
      organisationId,
      xeroInvoiceId: `xero-${invoice.id}`,
      contactId: customerId,
      invoiceNumber: invoice.invoiceNumber,
      type: 'ACCREC' as const,
      status: 'AUTHORISED' as const,
      issueDate: '2026-09-01',
      dueDate: invoice.dueDate,
      amountDue: invoice.amountDue,
      total: invoice.amountDue,
      currency: 'AUD',
      syncVersion: index + 10,
      updatedAt: new Date('2026-10-07T23:45:00.000Z')
    }))
  );
  await client.db.insert(invoiceChases).values(
    invoiceInput
      .filter((invoice) => invoice.withChase)
      .map((invoice) => ({
        organisationId,
        invoiceId: invoice.id,
        sequenceId,
        customerId,
        status: 'ACTIVE' as const
      }))
  );

  const session: AppSession = {
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'Voice Operator',
    expiresAt: '2026-10-09T00:00:00.000Z',
    memberships: [{ organisationId, role: 'OPERATOR', active: true }]
  };
  const publisher = {
    publish: vi.fn(() => Promise.resolve(randomUUID()))
  };
  const service = createVoiceCallService({
    database: client.db,
    repository: new PostgresVoiceCallRepository(client.db),
    publisher,
    session,
    clock: { now: () => now },
    holidays: { list: () => [] }
  });
  return {
    organisationId,
    otherOrganisationId,
    userId,
    customerId,
    otherCustomerId,
    invoiceInput,
    session,
    publisher,
    service
  };
}

describe('voice call service', () => {
  it('prepares one combined account call with every eligible invoice and stable exclusions', async () => {
    const seeded = await seed();
    const prepared = await seeded.service.prepare({
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      idempotencyKey: `voice-page-${randomUUID()}`
    });

    expect(prepared).toMatchObject({
      allowed: true,
      blockCode: null,
      customerId: seeded.customerId,
      customerName: 'Example Customer',
      destinationNumber: '+61412345678',
      destinationSource: '0412 345 678',
      outboundNumber: '+61255501234',
      callerIdentityLabel: '+61255501234',
      transferTargetLabel: 'Main office accounts queue',
      combinedAmount: '125.50',
      currency: 'AUD',
      attemptsLastSevenDays: 0,
      attemptsThisMonth: 0,
      nextPermittedAt: null,
      callFlowVersion: 1
    });
    expect(prepared.voiceCallId).toEqual(expect.any(String));
    expect(prepared.includedInvoices.map((invoice) => invoice.invoiceNumber)).toEqual([
      'INV-100',
      'INV-200'
    ]);
    expect(prepared.excludedInvoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invoiceNumber: 'INV-FUTURE',
          reasons: ['NOT_OVERDUE']
        }),
        expect.objectContaining({
          invoiceNumber: 'INV-NO-CHASE',
          reasons: ['NO_ACTIVE_CHASE']
        })
      ])
    );
  });

  it('preserves exact cents for approved facts above the JavaScript safe-integer range', async () => {
    const seeded = await seed();
    const invoiceId = seeded.invoiceInput[0]?.id;
    if (invoiceId === undefined) throw new Error('Expected a seeded invoice');
    await client.db
      .update(invoices)
      .set({
        amountDue: '90071992547409.9900',
        total: '90071992547409.9900',
        syncVersion: 44
      })
      .where(eq(invoices.id, invoiceId));

    const prepared = await seeded.service.prepare({
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      idempotencyKey: `voice-page-${randomUUID()}`
    });

    expect(
      prepared.includedInvoices.find((invoice) => invoice.invoiceId === invoiceId)
        ?.amountDue
    ).toBe('90071992547409.99');
    expect(prepared.combinedAmount).toBe('90071992547435.49');
    expect(prepared.approvedFacts?.combinedAmount).toBe('90071992547435.49');
  });

  it('rejects cross-organisation customer IDs before reading account facts', async () => {
    const seeded = await seed();
    await expect(
      seeded.service.prepare({
        organisationId: seeded.otherOrganisationId,
        customerId: seeded.otherCustomerId,
        idempotencyKey: `voice-page-${randomUUID()}`
      })
    ).rejects.toThrow('FORBIDDEN');
  });

  it('shows recent attempt counts and the exact next permitted time instead of scheduling', async () => {
    const seeded = await seed();
    await client.db.insert(voiceCallRequests).values(
      [1, 2, 3].map((daysAgo) => ({
        organisationId: seeded.organisationId,
        contactId: seeded.customerId,
        actorUserId: seeded.userId,
        provider: 'RETELL' as const,
        destinationNumber: '+61412345678',
        outboundNumber: '+61255501234',
        combinedAmount: '1.00',
        currency: 'AUD',
        callFlowVersion: 1,
        callFlowHash: 'sha256:flow-v1',
        approvedFactsHash: `sha256:facts-${daysAgo}`,
        agentId: 'agent_accountpulse',
        agentVersion: 7,
        voiceId: 'voice_au_1',
        voiceSettingsUpdatedAt: new Date('2026-10-07T23:30:00.000Z'),
        transferTargetLabel: 'Main office accounts queue',
        idempotencyKey: `attempt-${randomUUID()}`,
        state: 'COMPLETED' as const,
        approvedAt: new Date(now.getTime() - daysAgo * 86_400_000),
        queuedAt: new Date(now.getTime() - daysAgo * 86_400_000),
        providerAcceptedAt: new Date(now.getTime() - daysAgo * 86_400_000)
      }))
    );

    const prepared = await seeded.service.prepare({
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      idempotencyKey: `voice-page-${randomUUID()}`
    });

    expect(prepared).toMatchObject({
      allowed: false,
      blockCode: 'WEEKLY_FREQUENCY_LIMIT',
      voiceCallId: null,
      attemptsLastSevenDays: 3,
      attemptsThisMonth: 3
    });
    expect(prepared.nextPermittedAt?.toISOString()).toBe(
      '2026-10-12T00:00:00.000Z'
    );
    expect(seeded.publisher.publish).not.toHaveBeenCalled();
  });

  it('pins approved facts, queues idempotently, and keeps approved snapshots immutable', async () => {
    const seeded = await seed();
    const idempotencyKey = `voice-page-${randomUUID()}`;
    const prepared = await seeded.service.prepare({
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      idempotencyKey
    });
    if (prepared.voiceCallId === null) throw new Error('Expected a draft');

    const first = await seeded.service.approveAndQueue({
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      voiceCallId: prepared.voiceCallId,
      idempotencyKey,
      callFlowVersion: prepared.callFlowVersion,
      callFlowHash: prepared.callFlowHash,
      approvedFactsHash: prepared.approvedFactsHash ?? '',
      confirmed: true
    });
    const repeated = await seeded.service.approveAndQueue({
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      voiceCallId: prepared.voiceCallId,
      idempotencyKey,
      callFlowVersion: prepared.callFlowVersion,
      callFlowHash: prepared.callFlowHash,
      approvedFactsHash: prepared.approvedFactsHash ?? '',
      confirmed: true
    });

    expect(first).toEqual({ voiceCallId: prepared.voiceCallId, created: true });
    expect(repeated).toEqual({ voiceCallId: prepared.voiceCallId, created: false });
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, prepared.voiceCallId));
    expect(stored).toMatchObject({
      state: 'QUEUED',
      callFlowVersion: prepared.callFlowVersion,
      callFlowHash: prepared.callFlowHash,
      approvedFactsHash: prepared.approvedFactsHash
    });
    expect(seeded.publisher.publish).toHaveBeenNthCalledWith(
      1,
      'voice-call.execute',
      {
        organisationId: seeded.organisationId,
        voiceCallId: prepared.voiceCallId,
        provider: 'VOIPCLOUD'
      },
      { singletonKey: `voice-call:${prepared.voiceCallId}` }
    );
    expect(seeded.publisher.publish).toHaveBeenNthCalledWith(
      2,
      'voice-call.execute',
      {
        organisationId: seeded.organisationId,
        voiceCallId: prepared.voiceCallId,
        provider: 'VOIPCLOUD'
      },
      { singletonKey: `voice-call:${prepared.voiceCallId}` }
    );
    await expect(
      client.db
        .update(voiceCallInvoices)
        .set({ amountDue: '999.00' })
        .where(eq(voiceCallInvoices.voiceCallId, prepared.voiceCallId))
    ).rejects.toThrow();
  });

  it('changes the protected facts hash and refuses approval when an invoice changes', async () => {
    const seeded = await seed();
    const idempotencyKey = `voice-page-${randomUUID()}`;
    const prepared = await seeded.service.prepare({
      organisationId: seeded.organisationId,
      customerId: seeded.customerId,
      idempotencyKey
    });
    if (prepared.voiceCallId === null) throw new Error('Expected a draft');
    const approvedFacts = prepared.approvedFacts;
    if (approvedFacts === null) throw new Error('Expected approved facts');
    const changedHash = buildApprovedVoiceFactsHash({
      ...approvedFacts,
      invoices: approvedFacts.invoices.map((invoice, index) =>
        index === 0 ? { ...invoice, amountDue: '101.00' } : invoice
      )
    });
    expect(changedHash).not.toBe(prepared.approvedFactsHash);

    const invoiceId = prepared.includedInvoices[0]?.invoiceId;
    if (invoiceId === undefined) throw new Error('Expected an invoice');
    await client.db
      .update(invoices)
      .set({ amountDue: '101.0000', syncVersion: 99 })
      .where(eq(invoices.id, invoiceId));

    await expect(
      seeded.service.approveAndQueue({
        organisationId: seeded.organisationId,
        customerId: seeded.customerId,
        voiceCallId: prepared.voiceCallId,
        idempotencyKey,
        callFlowVersion: prepared.callFlowVersion,
        callFlowHash: prepared.callFlowHash,
        approvedFactsHash: prepared.approvedFactsHash ?? '',
        confirmed: true
      })
    ).rejects.toThrow('STALE_ACCOUNT_DATA');
    expect(seeded.publisher.publish).not.toHaveBeenCalled();
  });
});
