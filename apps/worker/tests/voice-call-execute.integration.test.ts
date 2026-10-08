import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  auditEvents,
  contactChannels,
  contacts,
  createDatabase,
  disputes,
  invoiceChases,
  invoices,
  memberships,
  migrateDatabase,
  organisations,
  organisationVoiceSettings,
  pauses,
  paymentPromises,
  PostgresVoiceCallRepository,
  reminderSequences,
  reminderWhitelistEntries,
  suppressions,
  users,
  voiceCallRequests
} from '@bc5000/db';
import {
  type RetellCreatePhoneCallInput,
  RetellPermanentError,
  RetellUnknownDispatchError
} from '@bc5000/integrations/retell';
import { fixedVoiceCallCopy } from '@bc5000/domain';

import { executeVoiceCall } from '../src/handlers/voice-call-execute.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-10-08T00:00:00.000Z');
const callFlowHash = `sha256:${createHash('sha256')
  .update(JSON.stringify(fixedVoiceCallCopy))
  .digest('hex')}`;

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedApprovedCall(
  options: { callFlowVersion?: number; callFlowHash?: string } = {}
) {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const voiceSettingsUpdatedAt = new Date('2026-10-07T23:30:00.000Z');

  await client.db.insert(organisations).values({
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
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Voice Operator'
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
    name: 'Example Customer',
    active: true,
    sourceVersion: 4
  });
  await client.db.insert(contactChannels).values({
    organisationId,
    contactId,
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
    previewPublicKey: 'public-preview-key',
    agentId: 'agent-accountpulse',
    agentVersion: 7,
    voiceId: 'voice-au-1',
    voiceLabel: 'Australian accounts voice',
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
    updatedAt: voiceSettingsUpdatedAt
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Voice sequence ${sequenceId}`,
    enabled: true
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: `xero-${invoiceId}`,
    contactId,
    invoiceNumber: 'INV-VOICE-1',
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-09-01',
    dueDate: '2026-09-10',
    amountDue: '100.0000',
    total: '100.0000',
    currency: 'AUD',
    syncVersion: 10,
    updatedAt: new Date('2026-10-07T23:45:00.000Z')
  });
  await client.db.insert(invoiceChases).values({
    organisationId,
    invoiceId,
    sequenceId,
    customerId: contactId,
    status: 'ACTIVE'
  });

  const repository = new PostgresVoiceCallRepository(client.db);
  const idempotencyKey = `voice-request-${randomUUID()}`;
  const draft = await repository.createDraft({
    organisationId,
    contactId,
    actorUserId: userId,
    destinationNumber: '+61412345678',
    outboundNumber: '+61255501234',
    combinedAmount: '100.00',
    currency: 'AUD',
    agentId: 'agent-accountpulse',
    agentVersion: 7,
    voiceId: 'voice-au-1',
    voiceSettingsUpdatedAt,
    transferTargetLabel: 'Main office accounts queue',
    idempotencyKey,
    invoices: [
      {
        invoiceId,
        xeroInvoiceId: `xero-${invoiceId}`,
        invoiceNumber: 'INV-VOICE-1',
        amountDue: '100.0000',
        currency: 'AUD',
        dueDate: '2026-09-10',
        syncVersion: 10,
        snapshotAt: now
      }
    ],
    now
  });
  await repository.approveAndQueue({
    organisationId,
    voiceCallId: draft.id,
    actorUserId: userId,
    idempotencyKey,
    callFlowVersion: options.callFlowVersion ?? 1,
    callFlowHash: options.callFlowHash ?? callFlowHash,
    approvedFactsHash: 'sha256:facts-v1',
    now
  });

  return {
    organisationId,
    userId,
    contactId,
    invoiceId,
    sequenceId,
    voiceCallId: draft.id,
    idempotencyKey,
    repository
  };
}

const executionDependencies = (
  repository: PostgresVoiceCallRepository,
  createPhoneCall: (input: RetellCreatePhoneCallInput) => Promise<{
    callId: string;
    callStatus: string;
  }>,
  options: {
    executionTime?: Date;
    holidays?: readonly string[];
  } = {}
) => {
  const readSecret = vi.fn(() => Promise.resolve('retell-private-key'));
  const createProvider = vi.fn((apiKey: string) => {
    expect(apiKey).toBe('retell-private-key');
    return { createPhoneCall };
  });
  const publish = vi.fn(() => Promise.resolve(randomUUID()));
  return {
    dependencies: {
      database: client.db,
      repository,
      clock: { now: () => options.executionTime ?? now },
      secrets: { read: readSecret },
      providerFactory: { create: createProvider },
      publisher: { publish },
      holidays: { list: () => options.holidays ?? [] }
    },
    readSecret,
    createProvider,
    publish
  };
};

async function insertAcceptedAttempt(
  seeded: Awaited<ReturnType<typeof seedApprovedCall>>,
  acceptedAt: Date,
  suffix: string
) {
  await client.db.insert(voiceCallRequests).values({
    organisationId: seeded.organisationId,
    contactId: seeded.contactId,
    actorUserId: seeded.userId,
    destinationNumber: '+61412345678',
    outboundNumber: '+61255501234',
    combinedAmount: '100.00',
    currency: 'AUD',
    callFlowVersion: 1,
    callFlowHash,
    approvedFactsHash: `sha256:prior-${suffix}`,
    agentId: 'agent-accountpulse',
    agentVersion: 7,
    voiceId: 'voice-au-1',
    voiceSettingsUpdatedAt: new Date('2026-10-07T23:30:00.000Z'),
    transferTargetLabel: 'Main office accounts queue',
    idempotencyKey: `prior-${suffix}-${randomUUID()}`,
    state: 'ACCEPTED',
    providerCallId: `retell-prior-${suffix}-${randomUUID()}`,
    approvedAt: acceptedAt,
    queuedAt: acceptedAt,
    providerAcceptedAt: acceptedAt,
    createdAt: acceptedAt,
    updatedAt: acceptedAt
  });
}

async function insertAdditionalChasedInvoice(
  seeded: Awaited<ReturnType<typeof seedApprovedCall>>
): Promise<string> {
  const invoiceId = randomUUID();
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId: seeded.organisationId,
    xeroInvoiceId: `xero-${invoiceId}`,
    contactId: seeded.contactId,
    invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-09-15',
    dueDate: '2026-09-20',
    amountDue: '50.0000',
    total: '50.0000',
    currency: 'AUD',
    syncVersion: 1,
    updatedAt: new Date('2026-10-07T23:50:00.000Z')
  });
  await client.db.insert(invoiceChases).values({
    organisationId: seeded.organisationId,
    invoiceId,
    sequenceId: seeded.sequenceId,
    customerId: seeded.contactId,
    status: 'ACTIVE'
  });
  return invoiceId;
}

describe('voice call execution', () => {
  it('revalidates approved facts and submits the minimum protected Retell call', async () => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'retell-call-1', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        correlationId: 'correlation-1'
      })
    ).resolves.toEqual({ kind: 'accepted', providerCallId: 'retell-call-1' });

    expect(runtime.readSecret).toHaveBeenCalledWith('env:RETELL_API_KEY');
    expect(createPhoneCall).toHaveBeenCalledTimes(1);
    expect(createPhoneCall).toHaveBeenCalledWith({
      fromNumber: '+61255501234',
      toNumber: '+61412345678',
      idempotencyKey: seeded.idempotencyKey,
      agentId: 'agent-accountpulse',
      agentVersion: 7,
      dynamicVariables: {
        accountpulse_call_id: seeded.voiceCallId,
        invoice_details_json:
          '[{"invoiceNumber":"INV-VOICE-1","amountDue":"100.00"}]',
        combined_amount: '100.00',
        currency: 'AUD',
        callback_number: '+61255504321',
        fallback_office_number: '+61255504321',
        transfer_sip_uri: 'sip:accounts@voipline.example'
      },
      metadata: {
        organisation_id: seeded.organisationId,
        voice_call_id: seeded.voiceCallId
      }
    });

    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      state: 'ACCEPTED',
      providerCallId: 'retell-call-1',
      providerAcceptedAt: now
    });
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, seeded.voiceCallId));
    expect(events.map((event) => event.eventType)).toContain(
      'VOICE_CALL_PROVIDER_ACCEPTED'
    );
    expect(JSON.stringify(events)).not.toContain('+61412345678');
    expect(JSON.stringify(events)).not.toContain('INV-VOICE-1');
    expect(runtime.publish).toHaveBeenCalledWith(
      'voice-call.reconcile',
      {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        correlationId: 'correlation-1'
      },
      {
        singletonKey: `voice-call-reconcile:${seeded.voiceCallId}`,
        startAfter: new Date('2026-10-08T00:15:00.000Z')
      }
    );
  });

  it('lets concurrent workers produce exactly one provider request', async () => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({
        callId: 'retell-call-concurrent',
        callStatus: 'registered'
      })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    const results = await Promise.all([
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      }),
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ]);

    expect(createPhoneCall).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.kind === 'accepted')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'existing')).toHaveLength(1);
  });

  const staleInvoiceMutations = [
    {
      name: 'amount',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db
          .update(invoices)
          .set({ amountDue: '101.0000' })
          .where(eq(invoices.id, seeded.invoiceId));
      }
    },
    {
      name: 'status',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db
          .update(invoices)
          .set({ status: 'PAID' })
          .where(eq(invoices.id, seeded.invoiceId));
      }
    },
    {
      name: 'due date',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db
          .update(invoices)
          .set({ dueDate: '2026-09-11' })
          .where(eq(invoices.id, seeded.invoiceId));
      }
    },
    {
      name: 'contact',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        const replacementContactId = randomUUID();
        await client.db.insert(contacts).values({
          id: replacementContactId,
          organisationId: seeded.organisationId,
          xeroContactId: randomUUID(),
          name: 'Replacement Customer',
          active: true
        });
        await client.db
          .update(invoices)
          .set({ contactId: replacementContactId })
          .where(eq(invoices.id, seeded.invoiceId));
      }
    },
    {
      name: 'sync version',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db
          .update(invoices)
          .set({ syncVersion: 11 })
          .where(eq(invoices.id, seeded.invoiceId));
      }
    }
  ];

  it.each(staleInvoiceMutations)(
    'cancels when the approved invoice $name changes',
    async ({ mutate }) => {
      const seeded = await seedApprovedCall();
      await mutate(seeded);
      const createPhoneCall = vi.fn(() =>
        Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
      );
      const runtime = executionDependencies(seeded.repository, createPhoneCall);

      await expect(
        executeVoiceCall(runtime.dependencies, {
          organisationId: seeded.organisationId,
          voiceCallId: seeded.voiceCallId
        })
      ).resolves.toEqual({ kind: 'cancelled', reason: 'STALE_ACCOUNT_DATA' });
      expect(createPhoneCall).not.toHaveBeenCalled();
    }
  );

  it('cancels when a newly eligible invoice was not part of the approval', async () => {
    const seeded = await seedApprovedCall();
    await insertAdditionalChasedInvoice(seeded);
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'STALE_ACCOUNT_DATA' });
    expect(createPhoneCall).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'disputed',
      exclude: async (
        seeded: Awaited<ReturnType<typeof seedApprovedCall>>,
        invoiceId: string
      ) => {
        await client.db.insert(disputes).values({
          organisationId: seeded.organisationId,
          contactId: seeded.contactId,
          invoiceId,
          status: 'OPEN',
          reason: 'Different invoice is disputed'
        });
      }
    },
    {
      name: 'paused',
      exclude: async (
        seeded: Awaited<ReturnType<typeof seedApprovedCall>>,
        invoiceId: string
      ) => {
        await client.db.insert(pauses).values({
          organisationId: seeded.organisationId,
          kind: 'MANUAL',
          scope: 'invoice',
          invoiceId,
          active: true,
          reason: 'Different invoice is paused'
        });
      }
    },
    {
      name: 'whitelisted',
      exclude: async (
        seeded: Awaited<ReturnType<typeof seedApprovedCall>>,
        invoiceId: string
      ) => {
        await client.db.insert(reminderWhitelistEntries).values({
          organisationId: seeded.organisationId,
          scope: 'INVOICE',
          contactId: seeded.contactId,
          invoiceId,
          reason: 'Different invoice is managed manually'
        });
      }
    }
  ])('does not invalidate approval for a separately $name invoice', async ({ exclude }) => {
    const seeded = await seedApprovedCall();
    const additionalInvoiceId = await insertAdditionalChasedInvoice(seeded);
    await exclude(seeded, additionalInvoiceId);
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'retell-excluded-extra', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({
      kind: 'accepted',
      providerCallId: 'retell-excluded-extra'
    });
    expect(createPhoneCall).toHaveBeenCalledTimes(1);
  });

  it('revalidates again after claiming and cancels a last-moment data change', async () => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);
    runtime.readSecret.mockImplementation(async () => {
      await client.db
        .update(invoices)
        .set({ amountDue: '125.0000' })
        .where(eq(invoices.id, seeded.invoiceId));
      return 'retell-private-key';
    });

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'STALE_ACCOUNT_DATA' });
    expect(createPhoneCall).not.toHaveBeenCalled();
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      state: 'CANCELLED',
      failureCode: 'STALE_ACCOUNT_DATA'
    });
  });

  it('uses a fresh post-claim time for the final calling-window check', async () => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);
    const clockNow = vi
      .fn()
      .mockReturnValueOnce(new Date('2026-10-08T05:59:00.000Z'))
      .mockReturnValue(new Date('2026-10-08T06:01:00.000Z'));
    runtime.dependencies.clock.now = clockNow;

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({
      kind: 'cancelled',
      reason: 'CALLING_WINDOW_CLOSED'
    });
    expect(clockNow).toHaveBeenCalledTimes(2);
    expect(createPhoneCall).not.toHaveBeenCalled();
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      state: 'CANCELLED',
      completedAt: new Date('2026-10-08T06:01:00.000Z')
    });
  });

  it('cancels as stale when the approved customer phone changes', async () => {
    const seeded = await seedApprovedCall();
    await client.db
      .update(contactChannels)
      .set({
        sourceValue: '0499 999 999',
        normalisedValue: '+61499999999'
      })
      .where(
        and(
          eq(contactChannels.organisationId, seeded.organisationId),
          eq(contactChannels.contactId, seeded.contactId),
          eq(contactChannels.kind, 'VOICE')
        )
      );
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'STALE_ACCOUNT_DATA' });
    expect(createPhoneCall).not.toHaveBeenCalled();
  });

  const policyBlocks = [
    {
      name: 'voice suppression',
      reason: 'VOICE_SUPPRESSED',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db.insert(suppressions).values({
          organisationId: seeded.organisationId,
          channel: 'VOICE',
          normalisedDestination: '+61412345678',
          source: 'TEST',
          reason: 'Customer opted out',
          consentState: 'SUPPRESSED'
        });
      }
    },
    {
      name: 'open dispute',
      reason: 'DISPUTE_OPEN',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db.insert(disputes).values({
          organisationId: seeded.organisationId,
          contactId: seeded.contactId,
          invoiceId: seeded.invoiceId,
          status: 'OPEN',
          reason: 'Amount disputed'
        });
      }
    },
    {
      name: 'active payment promise',
      reason: 'PROMISE_ACTIVE',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db.insert(paymentPromises).values({
          organisationId: seeded.organisationId,
          contactId: seeded.contactId,
          promisedDate: '2026-10-10',
          graceDays: 2,
          status: 'ACTIVE'
        });
      }
    },
    {
      name: 'active sequence pause',
      reason: 'PAUSED',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db.insert(pauses).values({
          organisationId: seeded.organisationId,
          kind: 'MANUAL',
          scope: 'sequence',
          sequenceId: seeded.sequenceId,
          active: true,
          reason: 'Sequence paused'
        });
      }
    },
    {
      name: 'client whitelist',
      reason: 'WHITELISTED',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db.insert(reminderWhitelistEntries).values({
          organisationId: seeded.organisationId,
          scope: 'CLIENT',
          contactId: seeded.contactId,
          reason: 'Managed manually'
        });
      }
    },
    {
      name: 'disabled initiating membership',
      reason: 'INITIATING_USER_DISABLED',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db
          .update(memberships)
          .set({ disabledAt: now })
          .where(
            and(
              eq(memberships.organisationId, seeded.organisationId),
              eq(memberships.userId, seeded.userId)
            )
          );
      }
    },
    {
      name: 'disabled voice feature',
      reason: 'FEATURE_DISABLED',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db
          .update(organisationVoiceSettings)
          .set({ enabled: false })
          .where(
            eq(
              organisationVoiceSettings.organisationId,
              seeded.organisationId
            )
          );
      }
    }
  ] as const;

  it.each(policyBlocks)(
    'cancels without provider submission for $name',
    async ({ mutate, reason }) => {
      const seeded = await seedApprovedCall();
      await mutate(seeded);
      const createPhoneCall = vi.fn(() =>
        Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
      );
      const runtime = executionDependencies(seeded.repository, createPhoneCall);

      await expect(
        executeVoiceCall(runtime.dependencies, {
          organisationId: seeded.organisationId,
          voiceCallId: seeded.voiceCallId
        })
      ).resolves.toEqual({ kind: 'cancelled', reason });
      expect(createPhoneCall).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: 'voice settings',
      mutate: async (seeded: Awaited<ReturnType<typeof seedApprovedCall>>) => {
        await client.db
          .update(organisationVoiceSettings)
          .set({ voiceId: 'voice-au-2' })
          .where(
            eq(
              organisationVoiceSettings.organisationId,
              seeded.organisationId
            )
          );
      }
    },
  ])('cancels as stale when $name changes', async ({ mutate }) => {
    const seeded = await seedApprovedCall();
    await mutate(seeded);
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'STALE_ACCOUNT_DATA' });
    expect(createPhoneCall).not.toHaveBeenCalled();
  });

  it('cancels an approval pinned to an obsolete flow version', async () => {
    const seeded = await seedApprovedCall({ callFlowVersion: 999 });
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'STALE_ACCOUNT_DATA' });
    expect(createPhoneCall).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'outside calling hours',
      executionTime: new Date('2026-10-08T08:00:00.000Z'),
      holidays: [] as string[]
    },
    {
      name: 'on a configured holiday',
      executionTime: now,
      holidays: ['2026-10-08']
    }
  ])('cancels when execution is $name', async ({ executionTime, holidays }) => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall, {
      executionTime,
      holidays
    });

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'cancelled', reason: 'CALLING_WINDOW_CLOSED' });
    expect(createPhoneCall).not.toHaveBeenCalled();
  });

  it('enforces the rolling weekly contact frequency limit', async () => {
    const seeded = await seedApprovedCall();
    await insertAcceptedAttempt(
      seeded,
      new Date('2026-10-05T00:00:00.000Z'),
      'weekly-1'
    );
    await insertAcceptedAttempt(
      seeded,
      new Date('2026-10-06T00:00:00.000Z'),
      'weekly-2'
    );
    await insertAcceptedAttempt(
      seeded,
      new Date('2026-10-07T00:00:00.000Z'),
      'weekly-3'
    );
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({
      kind: 'cancelled',
      reason: 'WEEKLY_FREQUENCY_LIMIT'
    });
    expect(createPhoneCall).not.toHaveBeenCalled();
  });

  it('prevents a second organisation call while another is in flight', async () => {
    const seeded = await seedApprovedCall();
    await insertAcceptedAttempt(
      seeded,
      new Date('2026-10-07T22:00:00.000Z'),
      'in-flight'
    );
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({
      kind: 'cancelled',
      reason: 'ORGANISATION_CALL_IN_FLIGHT'
    });
    expect(createPhoneCall).not.toHaveBeenCalled();
  });

  it('records a known provider rejection as failed without retrying', async () => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.reject(new RetellPermanentError(400, 'unsafe provider detail'))
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'failed', reason: 'PROVIDER_REJECTED' });
    expect(createPhoneCall).toHaveBeenCalledTimes(1);
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      state: 'FAILED',
      outcome: 'PROVIDER_REJECTED',
      failureCode: 'PROVIDER_REJECTED'
    });
    expect(JSON.stringify(stored)).not.toContain('unsafe provider detail');
  });

  it('does not claim the call when the managed provider secret is unavailable', async () => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.resolve({ callId: 'not-used', callStatus: 'registered' })
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);
    runtime.readSecret.mockRejectedValue(
      new Error('Managed secret is unavailable')
    );

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).rejects.toThrow('Managed secret is unavailable');
    expect(createPhoneCall).not.toHaveBeenCalled();
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored?.state).toBe('QUEUED');
  });

  it('records an uncertain dispatch as unknown and queues reconciliation only', async () => {
    const seeded = await seedApprovedCall();
    const createPhoneCall = vi.fn(() =>
      Promise.reject(new RetellUnknownDispatchError('unsafe network detail'))
    );
    const runtime = executionDependencies(seeded.repository, createPhoneCall);

    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        correlationId: 'correlation-unknown'
      })
    ).resolves.toEqual({ kind: 'unknown' });
    expect(createPhoneCall).toHaveBeenCalledTimes(1);
    expect(runtime.publish).toHaveBeenCalledTimes(1);
    expect(runtime.publish).toHaveBeenCalledWith(
      'voice-call.reconcile',
      {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        correlationId: 'correlation-unknown'
      },
      {
        singletonKey: `voice-call-reconcile:${seeded.voiceCallId}`,
        startAfter: new Date('2026-10-08T00:15:00.000Z')
      }
    );
    expect(JSON.stringify(runtime.publish.mock.calls)).not.toContain(
      'voice-call.execute'
    );
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      state: 'UNKNOWN',
      failureCode: 'DISPATCH_OUTCOME_UNKNOWN'
    });
    expect(JSON.stringify(stored)).not.toContain('unsafe network detail');

    runtime.publish.mockClear();
    await expect(
      executeVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        correlationId: 'correlation-unknown-retry'
      })
    ).resolves.toEqual({ kind: 'existing', state: 'UNKNOWN' });
    expect(createPhoneCall).toHaveBeenCalledTimes(1);
    expect(runtime.publish).toHaveBeenCalledWith(
      'voice-call.reconcile',
      {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        correlationId: 'correlation-unknown-retry'
      },
      { singletonKey: `voice-call-reconcile:${seeded.voiceCallId}` }
    );
  });
});
