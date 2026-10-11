import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  contacts,
  createDatabase,
  migrateDatabase,
  organisations,
  organisationVoiceSettings,
  suppressions,
  tasks,
  users,
  voiceCallEvents,
  voiceCallRequests
} from '@bc5000/db';
import type { VoiceGatewayCallStatus } from '@bc5000/integrations/voice-gateway';

import { reconcileVoiceCall } from '../src/handlers/voice-call-reconcile.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-10-08T01:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedCall(
  state: 'ACCEPTED' | 'UNKNOWN',
  options: {
    providerCallId?: string | null;
    purpose?: 'CUSTOMER' | 'TEST';
  } = {}
) {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  const voiceCallId = randomUUID();
  const providerCallId =
    options.providerCallId === undefined
      ? voiceCallId
      : options.providerCallId;
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Voice Reconciliation Organisation',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Voice Administrator'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Reconciliation Customer',
    active: true
  });
  await client.db.insert(organisationVoiceSettings).values({
    organisationId,
    enabled: true,
    configurationVersion: 2,
    provider: 'VOIPCLOUD',
    voipcloudUserNumber: '1099',
    ttsVoiceId: 'en_GB-alba-medium',
    gatewayFlowVersion: 1,
    outboundNumber: '+61255501234',
    fallbackOfficeNumber: '+61255504321',
    officeDestinationLabel: 'Main office accounts queue',
    timezone: 'Australia/Sydney',
    weekdayStartLocal: '09:00',
    weekdayEndLocal: '17:00',
    updatedByUserId: userId
  });
  await client.db.insert(voiceCallRequests).values({
    id: voiceCallId,
    organisationId,
    contactId,
    actorUserId: userId,
    purpose: options.purpose ?? 'CUSTOMER',
    accountName: 'Reconciliation Customer',
    destinationNumber:
      options.purpose === 'TEST' ? '+61400000124' : '+61412345678',
    outboundNumber: '+61255501234',
    combinedAmount: '100.00',
    currency: 'AUD',
    callFlowVersion: 1,
    callFlowHash: 'sha256:flow',
    approvedFactsHash: 'sha256:facts',
    voipcloudUserNumber: '1099',
    ttsVoiceId: 'en_GB-alba-medium',
    gatewayFlowVersion: 1,
    voiceSettingsUpdatedAt: new Date('2026-10-08T00:00:00.000Z'),
    transferTargetLabel: 'Main office accounts queue',
    idempotencyKey: `voice-${randomUUID()}`,
    state,
    providerCallId,
    approvedAt: new Date('2026-10-08T00:00:00.000Z'),
    queuedAt: new Date('2026-10-08T00:00:00.000Z'),
    providerAcceptedAt:
      providerCallId === null
        ? null
        : new Date('2026-10-08T00:00:30.000Z')
  });
  return { organisationId, contactId, voiceCallId, providerCallId };
}

const runtimeFor = (
  getCall: (callId: string) => Promise<VoiceGatewayCallStatus>
) => {
  const createCall = vi.fn();
  const gateway = { getCall: vi.fn(getCall), createCall };
  const publish = vi.fn(() => Promise.resolve(`job-${randomUUID()}`));
  return {
    dependencies: {
      database: client.db,
      clock: { now: () => now },
      gateway,
      publisher: { publish }
    },
    gateway,
    publish,
    createCall
  };
};

describe('voice call reconciliation', () => {
  it('reconciles an unknown call from its stored provider ID without redialling', async () => {
    const seeded = await seedCall('UNKNOWN');
    const runtime = runtimeFor((callId) =>
      Promise.resolve({
        gatewayCallId: callId,
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        providerUserNumber: '1099',
        state: 'COMPLETED',
        lastEventSequence: 8,
        safeFailureCode: 'VOICE_REMINDER_DELIVERED',
        createdAt: '2026-10-08T00:00:30.000Z',
        updatedAt: '2026-10-08T00:03:00.000Z'
      })
    );

    await expect(
      reconcileVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        correlationId: 'reconcile-1'
      })
    ).resolves.toEqual({
      kind: 'reconciled',
      state: 'COMPLETED',
      outcome: 'REMINDER_DELIVERED'
    });
    expect(runtime.gateway.getCall).toHaveBeenCalledWith(
      seeded.providerCallId
    );
    expect(runtime.createCall).not.toHaveBeenCalled();
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      state: 'COMPLETED',
      outcome: 'REMINDER_DELIVERED',
      failureCode: null
    });
    const events = await client.db
      .select()
      .from(voiceCallEvents)
      .where(eq(voiceCallEvents.voiceCallId, seeded.voiceCallId));
    expect(events.map((event) => event.eventType)).toContain(
      'VOICE_CALL_RECONCILED'
    );
    expect(JSON.stringify(events)).not.toMatch(
      /private-voipcloud-key|\+61412345678/
    );
  });

  it('moves an accepted ongoing call forward without creating another call', async () => {
    const seeded = await seedCall('ACCEPTED');
    const runtime = runtimeFor((callId) =>
      Promise.resolve({
        gatewayCallId: callId,
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        providerUserNumber: '1099',
        state: 'IN_PROGRESS',
        lastEventSequence: 5,
        safeFailureCode: null,
        createdAt: '2026-10-08T00:00:30.000Z',
        updatedAt: '2026-10-08T00:01:00.000Z'
      })
    );

    await expect(
      reconcileVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({ kind: 'pending', state: 'IN_PROGRESS' });
    expect(runtime.createCall).not.toHaveBeenCalled();
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored?.state).toBe('IN_PROGRESS');
    expect(stored?.answeredAt).toEqual(
      new Date('2026-10-08T00:01:00.000Z')
    );
    expect(runtime.publish).toHaveBeenCalledWith(
      'voice-call.reconcile',
      {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        provider: 'VOIPCLOUD'
      },
      {
        singletonKey: `voice-call-reconcile:${seeded.voiceCallId}:follow-up:1`,
        startAfter: new Date('2026-10-08T01:15:00.000Z')
      }
    );
  });

  it('bounds ongoing follow-up checks and opens one review task', async () => {
    const seeded = await seedCall('ACCEPTED');
    const runtime = runtimeFor((callId) =>
      Promise.resolve({
        gatewayCallId: callId,
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        providerUserNumber: '1099',
        state: 'IN_PROGRESS',
        lastEventSequence: 5,
        safeFailureCode: null,
        createdAt: '2026-10-08T00:00:30.000Z',
        updatedAt: '2026-10-08T00:01:00.000Z'
      })
    );

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        reconcileVoiceCall(runtime.dependencies, {
          organisationId: seeded.organisationId,
          voiceCallId: seeded.voiceCallId
        })
      ).resolves.toMatchObject({ kind: 'pending' });
    }
    await expect(
      reconcileVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({
      kind: 'manual-review',
      reason: 'OUTCOME_INCOMPLETE'
    });

    expect(runtime.publish).toHaveBeenCalledTimes(4);
    const reviewTasks = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.contactId, seeded.contactId));
    expect(
      reviewTasks.filter((task) => task.kind === 'VOICE_OUTCOME_REVIEW')
    ).toHaveLength(1);
  });

  it('suppresses and creates one contact review for a reconciled wrong-person call', async () => {
    const seeded = await seedCall('UNKNOWN');
    const runtime = runtimeFor((callId) =>
      Promise.resolve({
        gatewayCallId: callId,
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        providerUserNumber: '1099',
        state: 'COMPLETED',
        lastEventSequence: 7,
        safeFailureCode: 'VOICE_WRONG_NUMBER',
        createdAt: '2026-10-08T00:00:30.000Z',
        updatedAt: '2026-10-08T00:02:00.000Z'
      })
    );
    const payload = {
      organisationId: seeded.organisationId,
      voiceCallId: seeded.voiceCallId
    };

    await expect(reconcileVoiceCall(runtime.dependencies, payload)).resolves.toEqual({
      kind: 'reconciled',
      state: 'COMPLETED',
      outcome: 'WRONG_PERSON'
    });
    await expect(reconcileVoiceCall(runtime.dependencies, payload)).resolves.toEqual({
      kind: 'existing',
      state: 'COMPLETED'
    });

    const suppressionRows = await client.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.organisationId, seeded.organisationId));
    expect(suppressionRows).toHaveLength(1);
    expect(suppressionRows[0]).toMatchObject({
      channel: 'VOICE',
      consentState: 'SUPPRESSED'
    });
    const reviewTasks = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.contactId, seeded.contactId));
    expect(
      reviewTasks.filter((task) => task.kind === 'VOICE_CONTACT_REVIEW')
    ).toHaveLength(1);
  });

  it('reconciles a TEST wrong-person outcome without changing customer contact controls', async () => {
    const seeded = await seedCall('UNKNOWN', { purpose: 'TEST' });
    const runtime = runtimeFor((callId) =>
      Promise.resolve({
        gatewayCallId: callId,
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        providerUserNumber: '1099',
        state: 'COMPLETED',
        lastEventSequence: 7,
        safeFailureCode: 'VOICE_WRONG_NUMBER',
        createdAt: '2026-10-08T00:00:30.000Z',
        updatedAt: '2026-10-08T00:02:00.000Z'
      })
    );

    await expect(
      reconcileVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({
      kind: 'reconciled',
      state: 'COMPLETED',
      outcome: 'WRONG_PERSON'
    });
    const suppressionRows = await client.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.organisationId, seeded.organisationId));
    expect(suppressionRows).toHaveLength(0);
    const reviewTasks = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.contactId, seeded.contactId));
    expect(
      reviewTasks.filter((task) => task.kind === 'VOICE_CONTACT_REVIEW')
    ).toHaveLength(0);
  });

  it('requires manual review when an unknown call has no provider ID', async () => {
    const seeded = await seedCall('UNKNOWN', { providerCallId: null });
    const runtime = runtimeFor((callId) =>
      Promise.resolve({
        gatewayCallId: callId,
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId,
        providerUserNumber: '1099',
        state: 'COMPLETED',
        lastEventSequence: 1,
        safeFailureCode: 'VOICE_REMINDER_DELIVERED',
        createdAt: '2026-10-08T00:00:30.000Z',
        updatedAt: '2026-10-08T00:02:00.000Z'
      })
    );

    await expect(
      reconcileVoiceCall(runtime.dependencies, {
        organisationId: seeded.organisationId,
        voiceCallId: seeded.voiceCallId
      })
    ).resolves.toEqual({
      kind: 'manual-review',
      reason: 'PROVIDER_CALL_ID_MISSING'
    });
    expect(runtime.gateway.getCall).not.toHaveBeenCalled();
    expect(runtime.createCall).not.toHaveBeenCalled();
    const reviewTasks = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.contactId, seeded.contactId));
    expect(
      reviewTasks.filter((task) => task.kind === 'VOICE_OUTCOME_REVIEW')
    ).toHaveLength(1);
  });
});
