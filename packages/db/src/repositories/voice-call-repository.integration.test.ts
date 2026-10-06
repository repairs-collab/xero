import { randomUUID } from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  contacts,
  invoices,
  organisations,
  users,
  voiceCallInvoices,
  voiceCallRequests
} from '../schema/index.js';
import {
  PostgresVoiceCallRepository,
  type CreateVoiceCallDraftInput
} from './voice-call-repository.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const repository = new PostgresVoiceCallRepository(client.db);

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

const seedAccount = async (label: string) => {
  const organisationId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const actorUserId = randomUUID();
  const xeroInvoiceId = randomUUID();

  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: label,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(users).values({
    id: actorUserId,
    cognitoSubject: randomUUID(),
    email: actorUserId + '@example.invalid',
    displayName: label + ' operator'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: label + ' customer',
    active: true,
    sourceVersion: 4
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId,
    contactId,
    invoiceNumber: 'INV-' + invoiceId.slice(0, 8),
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '100.0000',
    total: '100.0000',
    currency: 'AUD',
    syncVersion: 7,
    xeroUpdatedAt: new Date('2026-10-07T00:00:00.000Z')
  });

  return {
    organisationId,
    contactId,
    invoiceId,
    actorUserId,
    xeroInvoiceId
  };
};

const draftInput = (
  seeded: Awaited<ReturnType<typeof seedAccount>>,
  patch: Partial<CreateVoiceCallDraftInput> = {}
): CreateVoiceCallDraftInput => ({
  organisationId: seeded.organisationId,
  contactId: seeded.contactId,
  actorUserId: seeded.actorUserId,
  destinationNumber: '+61400000000',
  outboundNumber: '+61255501234',
  combinedAmount: '100.0000',
  currency: 'AUD',
  script: 'Approved facts for one invoice.',
  scriptHash: 'sha256:draft',
  scriptVersion: 1,
  agentId: 'agent_accountpulse',
  agentVersion: 1,
  voiceId: 'voice_au',
  voiceSettingsUpdatedAt: new Date('2026-10-07T00:00:00.000Z'),
  transferTargetLabel: 'Main office',
  idempotencyKey: randomUUID(),
  invoices: [
    {
      invoiceId: seeded.invoiceId,
      xeroInvoiceId: seeded.xeroInvoiceId,
      invoiceNumber: 'INV-' + seeded.invoiceId.slice(0, 8),
      amountDue: '100.0000',
      currency: 'AUD',
      dueDate: '2026-08-31',
      syncVersion: 7,
      snapshotAt: new Date('2026-10-07T00:00:00.000Z')
    }
  ],
  now: new Date('2026-10-07T00:00:00.000Z'),
  ...patch
});

const previewAndApprove = async (
  organisationId: string,
  voiceCallId: string,
  actorUserId: string,
  idempotencyKey: string
) => {
  await repository.markPreviewed({
    organisationId,
    voiceCallId,
    script: 'Approved facts for one invoice.',
    scriptHash: 'sha256:approved',
    scriptVersion: 1,
    now: new Date('2026-10-07T00:01:00.000Z')
  });
  return repository.approveAndQueue({
    organisationId,
    voiceCallId,
    actorUserId,
    idempotencyKey,
    scriptHash: 'sha256:approved',
    now: new Date('2026-10-07T00:02:00.000Z')
  });
};

describe('PostgresVoiceCallRepository', () => {
  it('scopes every aggregate lookup and mutation to the organisation', async () => {
    const owner = await seedAccount('Voice owner');
    const outsider = await seedAccount('Voice outsider');
    const created = await repository.createDraft(draftInput(owner));

    await expect(
      repository.loadForExecution(outsider.organisationId, created.id)
    ).resolves.toBeNull();
    await expect(
      repository.findByProviderCallId(
        outsider.organisationId,
        'retell-owner-call'
      )
    ).resolves.toBeNull();
    await expect(
      repository.markPreviewed({
        organisationId: outsider.organisationId,
        voiceCallId: created.id,
        script: 'Cross-organisation mutation',
        scriptHash: 'sha256:cross-org',
        scriptVersion: 1,
        now: new Date('2026-10-07T00:01:00.000Z')
      })
    ).rejects.toThrow('VOICE_CALL_NOT_FOUND');
    await expect(
      repository.createDraft(
        draftInput(owner, { organisationId: outsider.organisationId })
      )
    ).rejects.toThrow('VOICE_CALL_SOURCE_MISMATCH');
    await expect(
      repository.appendEvent({
        organisationId: outsider.organisationId,
        voiceCallId: created.id,
        providerEventKey: `cross-org:${randomUUID()}`,
        eventType: 'CALL_STARTED',
        safeState: 'IN_PROGRESS',
        occurredAt: new Date('2026-10-07T00:05:00.000Z')
      })
    ).rejects.toThrow('VOICE_CALL_NOT_FOUND');
  });

  it('creates one queued intent and one winning submission claim for concurrent confirmation', async () => {
    const seeded = await seedAccount('Concurrent voice');
    const idempotencyKey = randomUUID();
    const created = await repository.createDraft(
      draftInput(seeded, { idempotencyKey })
    );
    await repository.markPreviewed({
      organisationId: seeded.organisationId,
      voiceCallId: created.id,
      script: 'Approved facts for one invoice.',
      scriptHash: 'sha256:approved',
      scriptVersion: 1,
      now: new Date('2026-10-07T00:01:00.000Z')
    });

    const approvals = await Promise.all([
      repository.approveAndQueue({
        organisationId: seeded.organisationId,
        voiceCallId: created.id,
        actorUserId: seeded.actorUserId,
        idempotencyKey,
        scriptHash: 'sha256:approved',
        now: new Date('2026-10-07T00:02:00.000Z')
      }),
      repository.approveAndQueue({
        organisationId: seeded.organisationId,
        voiceCallId: created.id,
        actorUserId: seeded.actorUserId,
        idempotencyKey,
        scriptHash: 'sha256:approved',
        now: new Date('2026-10-07T00:02:00.000Z')
      })
    ]);

    expect(approvals.map((result) => result.created).sort()).toEqual([
      false,
      true
    ]);
    const [storedCount] = await client.db
      .select({ value: count() })
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, seeded.organisationId),
          eq(voiceCallRequests.idempotencyKey, idempotencyKey)
        )
      );
    expect(storedCount?.value).toBe(1);

    const claims = await Promise.all([
      repository.claimForSubmission({
        organisationId: seeded.organisationId,
        voiceCallId: created.id,
        now: new Date('2026-10-07T00:03:00.000Z')
      }),
      repository.claimForSubmission({
        organisationId: seeded.organisationId,
        voiceCallId: created.id,
        now: new Date('2026-10-07T00:03:00.000Z')
      })
    ]);
    expect(claims.filter((result) => result.kind === 'claimed')).toHaveLength(
      1
    );
    expect(claims.filter((result) => result.kind === 'existing')).toHaveLength(
      1
    );
  });

  it('makes approved invoice snapshots immutable', async () => {
    const seeded = await seedAccount('Immutable voice');
    const input = draftInput(seeded);
    const created = await repository.createDraft(input);
    await previewAndApprove(
      seeded.organisationId,
      created.id,
      seeded.actorUserId,
      input.idempotencyKey
    );

    await expect(
      client.db
        .update(voiceCallInvoices)
        .set({ amountDue: '1.0000' })
        .where(eq(voiceCallInvoices.voiceCallId, created.id))
    ).rejects.toMatchObject({
      cause: {
        message: 'approved voice call invoice snapshots are immutable'
      }
    });
    await expect(
      client.db
        .delete(voiceCallInvoices)
        .where(eq(voiceCallInvoices.voiceCallId, created.id))
    ).rejects.toMatchObject({
      cause: {
        message: 'approved voice call invoice snapshots are immutable'
      }
    });
  });

  it('returns only provider-accepted attempts in the requested organisation and period', async () => {
    const seeded = await seedAccount('Attempt history');
    const accepted = await repository.createDraft(draftInput(seeded));
    const acceptedInput = draftInput(seeded);
    const second = await repository.createDraft(acceptedInput);
    await client.db
      .update(voiceCallRequests)
      .set({
        state: 'ACCEPTED',
        approvedScript: 'Approved facts',
        scriptHash: 'sha256:accepted',
        previewedAt: new Date('2026-10-01T00:00:00.000Z'),
        approvedAt: new Date('2026-10-01T00:01:00.000Z'),
        providerAcceptedAt: new Date('2026-10-02T00:00:00.000Z')
      })
      .where(eq(voiceCallRequests.id, accepted.id));
    await client.db
      .update(voiceCallRequests)
      .set({
        state: 'CANCELLED',
        providerAcceptedAt: null
      })
      .where(eq(voiceCallRequests.id, second.id));

    const attempts = await repository.recentProviderAcceptedAttempts({
      organisationId: seeded.organisationId,
      contactId: seeded.contactId,
      from: new Date('2026-10-01T00:00:00.000Z'),
      before: new Date('2026-10-08T00:00:00.000Z')
    });

    expect(attempts).toEqual([
      {
        voiceCallId: accepted.id,
        providerAcceptedAt: new Date('2026-10-02T00:00:00.000Z'),
        state: 'ACCEPTED',
        outcome: null
      }
    ]);
  });

  it('blocks a new submission while the same account has an unknown provider outcome', async () => {
    const seeded = await seedAccount('Unknown voice');
    const unknownInput = draftInput(seeded);
    const unknown = await repository.createDraft(unknownInput);
    await previewAndApprove(
      seeded.organisationId,
      unknown.id,
      seeded.actorUserId,
      unknownInput.idempotencyKey
    );
    await client.db
      .update(voiceCallRequests)
      .set({ state: 'UNKNOWN' })
      .where(eq(voiceCallRequests.id, unknown.id));

    const nextInput = draftInput(seeded);
    const next = await repository.createDraft(nextInput);
    await previewAndApprove(
      seeded.organisationId,
      next.id,
      seeded.actorUserId,
      nextInput.idempotencyKey
    );

    await expect(
      repository.claimForSubmission({
        organisationId: seeded.organisationId,
        voiceCallId: next.id,
        now: new Date('2026-10-07T01:00:00.000Z')
      })
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'UNKNOWN_OUTCOME'
    });
  });

  it('deduplicates provider events and finds provider calls only within the organisation', async () => {
    const seeded = await seedAccount('Provider event');
    const input = draftInput(seeded);
    const created = await repository.createDraft(input);
    await previewAndApprove(
      seeded.organisationId,
      created.id,
      seeded.actorUserId,
      input.idempotencyKey
    );
    await repository.claimForSubmission({
      organisationId: seeded.organisationId,
      voiceCallId: created.id,
      now: new Date('2026-10-07T00:03:00.000Z')
    });
    await repository.recordProviderAccepted({
      organisationId: seeded.organisationId,
      voiceCallId: created.id,
      providerCallId: 'retell-provider-event',
      now: new Date('2026-10-07T00:04:00.000Z')
    });
    const event = {
      organisationId: seeded.organisationId,
      voiceCallId: created.id,
      providerEventKey: 'retell-provider-event:call_started:1',
      eventType: 'CALL_STARTED',
      safeState: 'IN_PROGRESS' as const,
      occurredAt: new Date('2026-10-07T00:05:00.000Z')
    };

    await expect(repository.appendEvent(event)).resolves.toEqual({
      created: true
    });
    await expect(repository.appendEvent(event)).resolves.toEqual({
      created: false
    });
    await expect(
      repository.findByProviderCallId(
        seeded.organisationId,
        'retell-provider-event'
      )
    ).resolves.toMatchObject({ id: created.id });
    await expect(
      repository.findByProviderCallId(
        randomUUID(),
        'retell-provider-event'
      )
    ).resolves.toBeNull();
  });
});
