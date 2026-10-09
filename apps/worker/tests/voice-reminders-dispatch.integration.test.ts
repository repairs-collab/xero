import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  organisations,
  organisationVoiceSettings,
  PostgresVoiceCallRepository,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages,
  stageInstances,
  voiceCallRequests
} from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { dispatchDueVoiceReminders } from '../src/handlers/voice-reminders-dispatch.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

interface SeedOptions {
  automaticEnabled?: boolean;
  sequenceEnabled?: boolean;
  versionStatus?: 'ACTIVE' | 'RETIRED';
  mode?: 'REVIEW' | 'AUTOMATIC';
  maxCallsPerRun?: number;
  cooldownSeconds?: number;
  weekdayStartLocal?: string;
  weekdayEndLocal?: string;
}

async function seedDispatch(options: SeedOptions = {}) {
  const organisationId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const settingsUpdatedAt = new Date('2026-10-09T00:00:00.000Z');
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: `Voice dispatch ${organisationId}`,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true,
    operationalState: 'READY',
    lastSuccessfulSyncAt: settingsUpdatedAt
  });
  await client.db.insert(organisationVoiceSettings).values({
    organisationId,
    enabled: true,
    automaticEnabled: options.automaticEnabled ?? true,
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
    weekdayStartLocal: options.weekdayStartLocal ?? '09:00',
    weekdayEndLocal: options.weekdayEndLocal ?? '17:00',
    updatedAt: settingsUpdatedAt
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Voice sequence ${sequenceId}`,
    kind: 'VOICE',
    mode: options.mode ?? 'AUTOMATIC',
    enabled: options.sequenceEnabled ?? true
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
      maxCallsPerRun: options.maxCallsPerRun ?? 5,
      cooldownSeconds: options.cooldownSeconds ?? 120
    }
  });
  await client.db.insert(sequenceStages).values({
    organisationId,
    sequenceVersionId,
    stageKey: 'twenty-one-days-voice',
    offsetDays: 21,
    channel: 'VOICE'
  });

  const repository = new PostgresVoiceCallRepository(client.db);
  const addCall = async (input: {
    scheduledAt: Date;
    source?: 'SEQUENCE_AUTOMATIC' | 'SEQUENCE_REVIEW';
    localOccurrenceDate?: string;
  }) => {
    const contactId = randomUUID();
    const invoiceId = randomUUID();
    await client.db.insert(contacts).values({
      id: contactId,
      organisationId,
      xeroContactId: randomUUID(),
      name: `Dispatch customer ${contactId}`,
      active: true
    });
    await client.db.insert(invoices).values({
      id: invoiceId,
      organisationId,
      xeroInvoiceId: `xero-${invoiceId}`,
      contactId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '100.0000',
      total: '100.0000',
      currency: 'AUD',
      syncVersion: 4
    });
    await client.db.insert(invoiceChases).values({
      organisationId,
      invoiceId,
      sequenceId,
      customerId: contactId,
      status: 'ACTIVE'
    });
    const call = await repository.createPrepared({
      organisationId,
      contactId,
      actorUserId: null,
      accountName: `Dispatch customer ${contactId}`,
      destinationNumber: '+61412345678',
      outboundNumber: '+61255501234',
      combinedAmount: '100.0000',
      currency: 'AUD',
      voipcloudUserNumber: '1099',
      ttsVoiceId: 'en_GB-alba-medium',
      gatewayFlowVersion: 1,
      agentId: 'agent-accountpulse',
      agentVersion: 7,
      voiceId: 'voice-au-1',
      voiceSettingsUpdatedAt: settingsUpdatedAt,
      transferTargetLabel: 'Main office accounts queue',
      idempotencyKey: `voice-dispatch-${randomUUID()}`,
      initialState: 'APPROVED',
      source: {
        source: input.source ?? 'SEQUENCE_AUTOMATIC',
        sequenceId,
        sequenceVersionId,
        stageKey: 'twenty-one-days-voice',
        scheduledAt: input.scheduledAt,
        localOccurrenceDate: input.localOccurrenceDate ?? '2026-10-09'
      },
      callFlowVersion: 1,
      callFlowHash: 'sha256:flow-v1',
      approvedFactsHash: `sha256:facts-${invoiceId}`,
      invoices: [
        {
          invoiceId,
          xeroInvoiceId: `xero-${invoiceId}`,
          invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
          amountDue: '100.0000',
          currency: 'AUD',
          dueDate: '2026-08-31',
          syncVersion: 4,
          snapshotAt: settingsUpdatedAt
        }
      ],
      now: settingsUpdatedAt
    });
    return { call, contactId, invoiceId };
  };

  return {
    organisationId,
    sequenceId,
    sequenceVersionId,
    repository,
    addCall
  };
}

const publisher = () =>
  ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

const run = (
  seeded: Awaited<ReturnType<typeof seedDispatch>>,
  now: Date,
  jobs: ReturnType<typeof publisher>,
  acceptCustomerVoiceCalls = true
) =>
  dispatchDueVoiceReminders(
    {
      database: client.db,
      repository: seeded.repository,
      clock: { now: () => now },
      holidays: { list: () => [] },
      publisher: jobs,
      acceptCustomerVoiceCalls
    },
    seeded.organisationId
  );

describe('dispatchDueVoiceReminders', () => {
  it('queues and publishes only the oldest due call without changing Messaging or Customer-live state', async () => {
    const seeded = await seedDispatch();
    const now = new Date('2026-10-09T00:30:00.000Z');
    const oldest = await seeded.addCall({
      scheduledAt: new Date('2026-10-09T00:00:00.000Z')
    });
    const next = await seeded.addCall({
      scheduledAt: new Date('2026-10-09T00:05:00.000Z')
    });
    const messagingSequenceId = randomUUID();
    const messagingVersionId = randomUUID();
    await client.db.insert(reminderSequences).values({
      id: messagingSequenceId,
      organisationId: seeded.organisationId,
      name: `Messaging ${messagingSequenceId}`,
      kind: 'MESSAGING',
      mode: 'AUTOMATIC',
      enabled: true
    });
    await client.db.insert(reminderSequenceVersions).values({
      id: messagingVersionId,
      organisationId: seeded.organisationId,
      sequenceId: messagingSequenceId,
      versionNumber: 1,
      status: 'ACTIVE'
    });
    const [chase] = await client.db
      .select()
      .from(invoiceChases)
      .where(eq(invoiceChases.invoiceId, oldest.invoiceId));
    const messageStageId = randomUUID();
    await client.db.insert(stageInstances).values({
      id: messageStageId,
      organisationId: seeded.organisationId,
      invoiceChaseId: chase!.id,
      sequenceVersionId: messagingVersionId,
      stageKey: 'seven-days',
      channel: 'SMS',
      status: 'SENT',
      scheduledAt: new Date('2026-10-08T00:00:00.000Z'),
      sourceVersion: 4
    });
    const jobs = publisher();

    const summary = await run(seeded, now, jobs);
    const calls = await client.db
      .select({ id: voiceCallRequests.id, state: voiceCallRequests.state })
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.organisationId, seeded.organisationId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    const [messageStage] = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, messageStageId));

    expect(summary).toMatchObject({
      status: 'DISPATCHED',
      voiceCallId: oldest.call.id
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { id: oldest.call.id, state: 'QUEUED' },
        { id: next.call.id, state: 'APPROVED' }
      ])
    );
    expect(jobs.publish).toHaveBeenCalledTimes(1);
    expect(jobs.publish).toHaveBeenCalledWith(
      'voice-call.execute',
      {
        organisationId: seeded.organisationId,
        voiceCallId: oldest.call.id,
        provider: 'VOIPCLOUD',
        correlationId: oldest.call.idempotencyKey
      },
      expect.objectContaining({
        singletonKey: `voice-call.execute:${oldest.call.id}`
      })
    );
    expect(organisation).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CUSTOMER',
      liveSendAcknowledged: true
    });
    expect(messageStage?.status).toBe('SENT');
  });

  it('republishes a stranded queued call after a publish failure', async () => {
    const seeded = await seedDispatch();
    const due = await seeded.addCall({
      scheduledAt: new Date('2026-10-09T00:00:00.000Z')
    });
    const jobs = publisher();
    jobs.publish.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(
      run(seeded, new Date('2026-10-09T00:30:00.000Z'), jobs)
    ).rejects.toThrow('queue unavailable');
    await expect(
      seeded.repository.loadForExecution(seeded.organisationId, due.call.id)
    ).resolves.toMatchObject({ state: 'QUEUED' });

    jobs.publish.mockResolvedValueOnce(randomUUID());
    await expect(
      run(seeded, new Date('2026-10-09T00:31:00.000Z'), jobs)
    ).resolves.toMatchObject({ status: 'DISPATCHED', voiceCallId: due.call.id });
    expect(jobs.publish).toHaveBeenCalledTimes(2);
  });

  it('keeps automatic calls approved until both deployment and organisation automatic gates are open', async () => {
    for (const scenario of [
      { automaticEnabled: true, deployment: false },
      { automaticEnabled: false, deployment: true }
    ]) {
      const seeded = await seedDispatch({
        automaticEnabled: scenario.automaticEnabled
      });
      const due = await seeded.addCall({
        scheduledAt: new Date('2026-10-09T00:00:00.000Z')
      });
      const jobs = publisher();

      await run(
        seeded,
        new Date('2026-10-09T00:30:00.000Z'),
        jobs,
        scenario.deployment
      );

      await expect(
        seeded.repository.loadForExecution(
          seeded.organisationId,
          due.call.id
        )
      ).resolves.toMatchObject({ state: 'APPROVED' });
      expect(jobs.publish).not.toHaveBeenCalled();
    }
  });

  it('dispatches an approved Review call without requiring the automatic organisation gate', async () => {
    const seeded = await seedDispatch({
      automaticEnabled: false,
      mode: 'REVIEW'
    });
    const due = await seeded.addCall({
      scheduledAt: new Date('2026-10-09T00:00:00.000Z'),
      source: 'SEQUENCE_REVIEW'
    });
    const jobs = publisher();

    await run(seeded, new Date('2026-10-09T00:30:00.000Z'), jobs);

    await expect(
      seeded.repository.loadForExecution(seeded.organisationId, due.call.id)
    ).resolves.toMatchObject({ state: 'QUEUED' });
    expect(jobs.publish).toHaveBeenCalledTimes(1);
  });

  it('blocks the organisation while a call is active or has an unknown outcome', async () => {
    for (const blockingState of ['ACCEPTED', 'IN_PROGRESS', 'UNKNOWN'] as const) {
      const seeded = await seedDispatch();
      const blocker = await seeded.addCall({
        scheduledAt: new Date('2026-10-08T23:00:00.000Z')
      });
      await client.db
        .update(voiceCallRequests)
        .set({ state: blockingState })
        .where(eq(voiceCallRequests.id, blocker.call.id));
      const due = await seeded.addCall({
        scheduledAt: new Date('2026-10-09T00:00:00.000Z')
      });
      const jobs = publisher();

      await run(seeded, new Date('2026-10-09T00:30:00.000Z'), jobs);

      await expect(
        seeded.repository.loadForExecution(
          seeded.organisationId,
          due.call.id
        )
      ).resolves.toMatchObject({ state: 'APPROVED' });
      expect(jobs.publish).not.toHaveBeenCalled();
    }
  });

  it('waits for terminal-call cooldown and then releases the next call', async () => {
    const seeded = await seedDispatch({ cooldownSeconds: 120 });
    const completed = await seeded.addCall({
      scheduledAt: new Date('2026-10-08T23:00:00.000Z')
    });
    await client.db
      .update(voiceCallRequests)
      .set({
        state: 'COMPLETED',
        queuedAt: new Date('2026-10-08T23:55:00.000Z'),
        completedAt: new Date('2026-10-08T23:59:00.000Z')
      })
      .where(eq(voiceCallRequests.id, completed.call.id));
    const due = await seeded.addCall({
      scheduledAt: new Date('2026-10-09T00:00:00.000Z'),
      localOccurrenceDate: '2026-10-10'
    });
    const jobs = publisher();

    const waiting = await run(
      seeded,
      new Date('2026-10-09T00:00:00.000Z'),
      jobs
    );
    expect(waiting).toMatchObject({
      status: 'DEFERRED',
      nextDispatchAt: new Date('2026-10-09T00:01:00.000Z')
    });
    expect(jobs.publish).not.toHaveBeenCalled();

    await run(seeded, new Date('2026-10-09T00:01:00.000Z'), jobs);
    await expect(
      seeded.repository.loadForExecution(seeded.organisationId, due.call.id)
    ).resolves.toMatchObject({ state: 'QUEUED' });
    expect(jobs.publish).toHaveBeenCalledTimes(1);
  });

  it('defers after the Friday window to the exact next Sydney business opening', async () => {
    const seeded = await seedDispatch();
    await seeded.addCall({
      scheduledAt: new Date('2026-10-09T07:00:00.000Z')
    });
    const jobs = publisher();

    const summary = await run(
      seeded,
      new Date('2026-10-09T07:30:00.000Z'),
      jobs
    );

    expect(summary).toMatchObject({
      status: 'DEFERRED',
      nextDispatchAt: new Date('2026-10-11T22:00:00.000Z')
    });
    expect(jobs.publish).not.toHaveBeenCalled();
  });

  it('does not dispatch from a disabled sequence or retired version, or beyond the occurrence cap', async () => {
    for (const change of [
      { kind: 'sequence' as const },
      { kind: 'version' as const }
    ]) {
      const seeded = await seedDispatch();
      const due = await seeded.addCall({
        scheduledAt: new Date('2026-10-09T00:00:00.000Z')
      });
      if (change.kind === 'sequence') {
        await client.db
          .update(reminderSequences)
          .set({ enabled: false })
          .where(eq(reminderSequences.id, seeded.sequenceId));
      } else {
        await client.db
          .update(reminderSequenceVersions)
          .set({ status: 'RETIRED' })
          .where(eq(reminderSequenceVersions.id, seeded.sequenceVersionId));
      }
      const jobs = publisher();
      await run(seeded, new Date('2026-10-09T00:30:00.000Z'), jobs);
      await expect(
        seeded.repository.loadForExecution(
          seeded.organisationId,
          due.call.id
        )
      ).resolves.toMatchObject({ state: 'APPROVED' });
      expect(jobs.publish).not.toHaveBeenCalled();
    }

    const capped = await seedDispatch({
      maxCallsPerRun: 1,
      cooldownSeconds: 30
    });
    const attempted = await capped.addCall({
      scheduledAt: new Date('2026-10-09T00:00:00.000Z')
    });
    await client.db
      .update(voiceCallRequests)
      .set({
        state: 'COMPLETED',
        queuedAt: new Date('2026-10-09T00:00:00.000Z'),
        completedAt: new Date('2026-10-09T00:01:00.000Z')
      })
      .where(eq(voiceCallRequests.id, attempted.call.id));
    const cappedDue = await capped.addCall({
      scheduledAt: new Date('2026-10-09T00:05:00.000Z')
    });
    const jobs = publisher();
    await run(capped, new Date('2026-10-09T00:30:00.000Z'), jobs);
    await expect(
      capped.repository.loadForExecution(
        capped.organisationId,
        cappedDue.call.id
      )
    ).resolves.toMatchObject({ state: 'APPROVED' });
    expect(jobs.publish).not.toHaveBeenCalled();
  });
});
