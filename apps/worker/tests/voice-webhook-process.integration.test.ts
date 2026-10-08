import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  contacts,
  createDatabase,
  memberships,
  migrateDatabase,
  organisations,
  PostgresWebhookRepository,
  suppressions,
  tasks,
  users,
  voiceCallEvents,
  voiceCallRequests,
  webhookEvents
} from '@bc5000/db';
import { parseRetellWebhook } from '@bc5000/integrations/retell';

import { processWebhookEvent } from '../src/handlers/webhook-process.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const organisationId = randomUUID();
const userId = randomUUID();
const receivedAt = new Date('2026-10-08T00:05:00.000Z');

beforeAll(async () => {
  await migrateDatabase(client.db);
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Voice Webhook Organisation',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true
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
});

afterAll(async () => client.pool.end());

async function seedAcceptedCall(
  options: {
    purpose?: 'CUSTOMER' | 'TEST';
    destinationNumber?: string;
  } = {}
) {
  const contactId = randomUUID();
  const voiceCallId = randomUUID();
  const providerCallId = `retell-${randomUUID()}`;
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Voice Customer',
    active: true
  });
  await client.db.insert(voiceCallRequests).values({
    id: voiceCallId,
    organisationId,
    contactId,
    actorUserId: userId,
    provider: 'RETELL',
    purpose: options.purpose ?? 'CUSTOMER',
    destinationNumber: options.destinationNumber ?? '+61412345678',
    outboundNumber: '+61255501234',
    combinedAmount: '100.00',
    currency: 'AUD',
    callFlowVersion: 1,
    callFlowHash: 'sha256:flow',
    approvedFactsHash: 'sha256:facts',
    agentId: 'agent-accountpulse',
    agentVersion: 7,
    voiceId: 'voice-au-1',
    voiceSettingsUpdatedAt: new Date('2026-10-08T00:00:00.000Z'),
    transferTargetLabel: 'Main office accounts queue',
    idempotencyKey: `voice-${randomUUID()}`,
    state: 'ACCEPTED',
    providerCallId,
    approvedAt: new Date('2026-10-08T00:00:00.000Z'),
    queuedAt: new Date('2026-10-08T00:00:00.000Z'),
    providerAcceptedAt: new Date('2026-10-08T00:00:30.000Z')
  });
  return { contactId, voiceCallId, providerCallId };
}

const encode = (value: unknown): string => JSON.stringify(value);

async function recordRetellEvent(rawBody: string) {
  const parsed = parseRetellWebhook(Buffer.from(rawBody));
  const repository = new PostgresWebhookRepository(client.db);
  const recorded = await repository.recordOnceWithId({
    organisationId,
    provider: 'RETELL',
    providerEventId: parsed.eventKey,
    rawBody,
    signatureValid: true
  });
  await client.db
    .update(webhookEvents)
    .set({ receivedAt })
    .where(eq(webhookEvents.id, recorded.id));
  return recorded.id;
}

const publisher = { publish: vi.fn(() => Promise.resolve(randomUUID())) };

async function processRetell(rawBody: string) {
  const webhookEventId = await recordRetellEvent(rawBody);
  await processWebhookEvent(
    { database: client.db, publisher },
    { organisationId, webhookEventId, provider: 'RETELL' }
  );
  return webhookEventId;
}

const analyzedBody = (
  providerCallId: string,
  structuredOutcome: Record<string, unknown>
): string =>
  encode({
    event: 'call_analyzed',
    call: {
      call_id: providerCallId,
      call_status: 'ended',
      start_timestamp: Date.parse('2026-10-08T00:01:00.000Z'),
      end_timestamp: Date.parse('2026-10-08T00:03:00.000Z'),
      transcript: 'private customer speech that must be discarded',
      recording_url: 'https://example.invalid/private.wav',
      call_analysis: {
        call_summary: 'private summary that must be discarded',
        call_successful: true,
        custom_analysis_data: {
          ...structuredOutcome,
          customer_said: 'private arbitrary text'
        }
      }
    }
  });

describe('Retell webhook processing', () => {
  it.each([
    {
      name: 'option 1 detail delivery',
      outcome: {
        identity_result: 'confirmed',
        final_result: 'details_delivered'
      },
      state: 'COMPLETED',
      finalOutcome: 'REMINDER_DELIVERED',
      present: [
        'VOICE_IDENTITY_CONFIRMED',
        'VOICE_REMINDER_DELIVERED'
      ],
      absent: []
    },
    {
      name: 'opening option 2 transfer',
      outcome: {
        transfer_requested: true,
        transfer_result: 'bridged',
        final_result: 'transferred'
      },
      state: 'COMPLETED',
      finalOutcome: 'TRANSFERRED',
      present: ['VOICE_TRANSFER_REQUESTED', 'VOICE_TRANSFERRED'],
      absent: ['VOICE_IDENTITY_CONFIRMED', 'VOICE_REMINDER_DELIVERED']
    },
    {
      name: 'option 2 transfer after details',
      outcome: {
        identity_result: 'confirmed',
        transfer_requested: true,
        transfer_result: 'bridged',
        final_result: 'transferred'
      },
      state: 'COMPLETED',
      finalOutcome: 'TRANSFERRED',
      present: [
        'VOICE_IDENTITY_CONFIRMED',
        'VOICE_REMINDER_DELIVERED',
        'VOICE_TRANSFER_REQUESTED',
        'VOICE_TRANSFERRED'
      ],
      absent: []
    },
    {
      name: 'identity not confirmed',
      outcome: { identity_result: 'not_confirmed' },
      state: 'COMPLETED',
      finalOutcome: 'IDENTITY_NOT_CONFIRMED',
      present: ['VOICE_IDENTITY_NOT_CONFIRMED'],
      absent: ['VOICE_REMINDER_DELIVERED']
    },
    {
      name: 'voicemail',
      outcome: { voicemail_left: true, final_result: 'voicemail_left' },
      state: 'COMPLETED',
      finalOutcome: 'VOICEMAIL_LEFT',
      present: ['VOICE_VOICEMAIL_LEFT'],
      absent: ['VOICE_REMINDER_DELIVERED']
    },
    {
      name: 'wrong person',
      outcome: { wrong_person: true, final_result: 'wrong_person' },
      state: 'COMPLETED',
      finalOutcome: 'WRONG_PERSON',
      present: ['VOICE_WRONG_PERSON_REPORTED'],
      absent: ['VOICE_IDENTITY_CONFIRMED', 'VOICE_REMINDER_DELIVERED']
    },
    {
      name: 'unanswered transfer',
      outcome: {
        transfer_requested: true,
        transfer_result: 'unanswered',
        final_result: 'transfer_unanswered'
      },
      state: 'COMPLETED',
      finalOutcome: 'TRANSFER_UNANSWERED',
      present: [
        'VOICE_TRANSFER_REQUESTED',
        'VOICE_TRANSFER_UNANSWERED'
      ],
      absent: ['VOICE_REMINDER_DELIVERED']
    },
    {
      name: 'no answer',
      outcome: { final_result: 'no_answer' },
      state: 'COMPLETED',
      finalOutcome: 'NO_ANSWER',
      present: ['VOICE_NO_ANSWER'],
      absent: ['VOICE_REMINDER_DELIVERED']
    },
    {
      name: 'busy',
      outcome: { final_result: 'busy' },
      state: 'COMPLETED',
      finalOutcome: 'BUSY',
      present: ['VOICE_BUSY'],
      absent: ['VOICE_REMINDER_DELIVERED']
    },
    {
      name: 'provider failure',
      outcome: { final_result: 'provider_rejected' },
      state: 'FAILED',
      finalOutcome: 'PROVIDER_REJECTED',
      present: ['VOICE_CALL_FAILED'],
      absent: ['VOICE_REMINDER_DELIVERED']
    }
  ] as const)(
    'normalises $name without retaining private provider content',
    async ({ outcome, state, finalOutcome, present, absent, name }) => {
      const seeded = await seedAcceptedCall();
      await processRetell(analyzedBody(seeded.providerCallId, outcome));

      const [stored] = await client.db
        .select()
        .from(voiceCallRequests)
        .where(eq(voiceCallRequests.id, seeded.voiceCallId));
      expect(stored).toMatchObject({ state, outcome: finalOutcome });
      const events = await client.db
        .select()
        .from(voiceCallEvents)
        .where(eq(voiceCallEvents.voiceCallId, seeded.voiceCallId));
      const eventTypes = events.map((event) => event.eventType);
      for (const eventType of present) expect(eventTypes).toContain(eventType);
      for (const eventType of absent) {
        expect(eventTypes).not.toContain(eventType);
      }
      expect(JSON.stringify(events)).not.toMatch(
        /private customer speech|private summary|private arbitrary text|recording_url/i
      );

      const reviewTasks = await client.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.organisationId, organisationId),
            eq(tasks.contactId, seeded.contactId)
          )
        );
      if (name === 'wrong person') {
        const blocked = await client.db
          .select()
          .from(suppressions)
          .where(
            and(
              eq(suppressions.organisationId, organisationId),
              eq(suppressions.channel, 'VOICE'),
              eq(suppressions.normalisedDestination, '+61412345678')
            )
          );
        expect(blocked).toHaveLength(1);
        expect(blocked[0]?.consentState).toBe('SUPPRESSED');
        expect(
          reviewTasks.filter((task) => task.kind === 'VOICE_CONTACT_REVIEW')
        ).toHaveLength(1);
      }
    }
  );

  it('records a TEST wrong-person outcome without suppressing or flagging the customer', async () => {
    const destinationNumber = '+61400000123';
    const seeded = await seedAcceptedCall({
      purpose: 'TEST',
      destinationNumber
    });
    await processRetell(
      analyzedBody(seeded.providerCallId, {
        wrong_person: true,
        final_result: 'wrong_person'
      })
    );

    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      purpose: 'TEST',
      state: 'COMPLETED',
      outcome: 'WRONG_PERSON'
    });
    const blocked = await client.db
      .select()
      .from(suppressions)
      .where(
        and(
          eq(suppressions.organisationId, organisationId),
          eq(suppressions.channel, 'VOICE'),
          eq(suppressions.normalisedDestination, destinationNumber)
        )
      );
    expect(blocked).toHaveLength(0);
    const reviewTasks = await client.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.organisationId, organisationId),
          eq(tasks.contactId, seeded.contactId),
          eq(tasks.kind, 'VOICE_CONTACT_REVIEW')
        )
      );
    expect(reviewTasks).toHaveLength(0);
  });

  it('is idempotent and monotonic when analyzed, ended, and started arrive out of order', async () => {
    const seeded = await seedAcceptedCall();
    const analyzed = analyzedBody(seeded.providerCallId, {
      identity_result: 'confirmed',
      final_result: 'details_delivered'
    });
    const analyzedWebhookId = await processRetell(analyzed);
    const eventsAfterAnalyzed = await client.db
      .select()
      .from(voiceCallEvents)
      .where(eq(voiceCallEvents.voiceCallId, seeded.voiceCallId));

    await processWebhookEvent(
      { database: client.db, publisher },
      {
        organisationId,
        webhookEventId: analyzedWebhookId,
        provider: 'RETELL'
      }
    );
    await processRetell(
      encode({
        event: 'call_ended',
        call: {
          call_id: seeded.providerCallId,
          call_status: 'ended',
          start_timestamp: Date.parse('2026-10-08T00:01:00.000Z'),
          end_timestamp: Date.parse('2026-10-08T00:03:00.000Z')
        }
      })
    );
    await processRetell(
      encode({
        event: 'call_started',
        call: {
          call_id: seeded.providerCallId,
          call_status: 'ongoing',
          start_timestamp: Date.parse('2026-10-08T00:01:00.000Z')
        }
      })
    );

    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.voiceCallId));
    expect(stored).toMatchObject({
      state: 'COMPLETED',
      outcome: 'REMINDER_DELIVERED'
    });
    const finalEvents = await client.db
      .select()
      .from(voiceCallEvents)
      .where(eq(voiceCallEvents.voiceCallId, seeded.voiceCallId));
    expect(finalEvents).toHaveLength(eventsAfterAnalyzed.length + 2);
    expect(
      finalEvents.filter(
        (event) => event.eventType === 'VOICE_REMINDER_DELIVERED'
      )
    ).toHaveLength(1);
  });

  it('creates one safe outcome-review task for incomplete or contradictory analysis', async () => {
    const seeded = await seedAcceptedCall();
    const body = analyzedBody(seeded.providerCallId, {
      identity_result: 'confirmed',
      wrong_person: true,
      final_result: 'details_delivered'
    });
    const webhookId = await processRetell(body);
    await processWebhookEvent(
      { database: client.db, publisher },
      { organisationId, webhookEventId: webhookId, provider: 'RETELL' }
    );

    const reviewTasks = await client.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.organisationId, organisationId),
          eq(tasks.contactId, seeded.contactId),
          eq(tasks.kind, 'VOICE_OUTCOME_REVIEW')
        )
      );
    expect(reviewTasks).toHaveLength(1);
    expect(JSON.stringify(reviewTasks)).not.toMatch(
      /private customer speech|private summary|private arbitrary text/i
    );
    const events = await client.db
      .select()
      .from(voiceCallEvents)
      .where(eq(voiceCallEvents.voiceCallId, seeded.voiceCallId));
    expect(events.map((event) => event.eventType)).not.toContain(
      'VOICE_REMINDER_DELIVERED'
    );
  });
});
