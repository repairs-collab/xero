import { and, eq, sql } from 'drizzle-orm';

import {
  type Database,
  type DbTransaction,
  organisationVoiceSettings,
  suppressions,
  tasks,
  voiceCallEvents,
  voiceCallRequests
} from '@bc5000/db';
import {
  transitionVoiceCallState,
  type VoiceCallEvent,
  type VoiceCallOperationalState,
  type VoiceCallOutcome,
  type VoiceCallState
} from '@bc5000/domain';
import type {
  RetellCallStatus,
  RetellStructuredOutcome
} from '@bc5000/integrations/retell';
import {
  jobNames,
  type JobPublisher,
  type VoiceCallReconcilePayload
} from '@bc5000/jobs';

export interface VoiceCallStatusProvider {
  getCall(callId: string): Promise<RetellCallStatus>;
}

export interface VoiceCallReconcileDependencies {
  database: Database;
  clock: { now(): Date };
  secrets: { read(reference: string): Promise<string> };
  providerFactory: { create(apiKey: string): VoiceCallStatusProvider };
  publisher: JobPublisher;
}

export type VoiceCallReconcileResult =
  | {
      kind: 'reconciled';
      state: 'COMPLETED' | 'FAILED';
      outcome: VoiceCallOutcome;
    }
  | { kind: 'pending'; state: VoiceCallOperationalState }
  | { kind: 'existing'; state: VoiceCallOperationalState }
  | { kind: 'manual-review'; reason: 'PROVIDER_CALL_ID_MISSING' | 'OUTCOME_INCOMPLETE' };

const terminalStates = new Set<VoiceCallOperationalState>([
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

const safeOutcome = (
  outcome: RetellStructuredOutcome | undefined
): VoiceCallOutcome | null => {
  if (outcome === undefined) return null;
  if (outcome.wrongPerson === true || outcome.finalResult === 'wrong_person') {
    return 'WRONG_PERSON';
  }
  if (
    outcome.voicemailLeft === true ||
    outcome.finalResult === 'voicemail_left'
  ) {
    return 'VOICEMAIL_LEFT';
  }
  if (outcome.identityResult === 'not_confirmed') {
    return 'IDENTITY_NOT_CONFIRMED';
  }
  switch (outcome.finalResult) {
    case 'details_delivered':
      return outcome.identityResult === 'confirmed'
        ? 'REMINDER_DELIVERED'
        : null;
    case 'transferred':
      return 'TRANSFERRED';
    case 'transfer_unanswered':
      return 'TRANSFER_UNANSWERED';
    case 'no_answer':
      return 'NO_ANSWER';
    case 'busy':
      return 'BUSY';
    case 'invalid_destination':
      return 'INVALID_DESTINATION';
    case 'provider_rejected':
      return 'PROVIDER_REJECTED';
    default:
      return null;
  }
};

const terminalEventFor = (outcome: VoiceCallOutcome): VoiceCallEvent => {
  switch (outcome) {
    case 'IDENTITY_NOT_CONFIRMED':
      return 'IDENTITY_NOT_CONFIRMED';
    case 'REMINDER_DELIVERED':
      return 'CALL_ENDED';
    case 'VOICEMAIL_LEFT':
      return 'VOICEMAIL_LEFT';
    case 'WRONG_PERSON':
      return 'WRONG_PERSON';
    case 'TRANSFERRED':
      return 'TRANSFERRED';
    case 'TRANSFER_UNANSWERED':
      return 'TRANSFER_UNANSWERED';
    case 'NO_ANSWER':
      return 'NO_ANSWER';
    case 'BUSY':
      return 'BUSY';
    case 'INVALID_DESTINATION':
      return 'INVALID_DESTINATION';
    case 'PROVIDER_REJECTED':
      return 'PROVIDER_REJECTED';
    case 'IDENTITY_CONFIRMED':
      return 'IDENTITY_CONFIRMED';
    case 'TRANSFER_REQUESTED':
      return 'TRANSFER_REQUESTED';
  }
};

const impliesAnswered = (outcome: VoiceCallOutcome): boolean =>
  ![
    'VOICEMAIL_LEFT',
    'NO_ANSWER',
    'BUSY',
    'INVALID_DESTINATION',
    'PROVIDER_REJECTED'
  ].includes(outcome);

const providerTime = (
  status: RetellCallStatus,
  fallback: Date
): Date => {
  const source = status.endTimestamp ?? status.startTimestamp;
  if (source === undefined) return fallback;
  const value = new Date(source);
  return Number.isFinite(value.getTime()) ? value : fallback;
};

const ensureVoiceReviewInTransaction = async (
  transaction: DbTransaction,
  input: {
    organisationId: string;
    contactId: string;
    now: Date;
    kind: 'VOICE_CONTACT_REVIEW' | 'VOICE_OUTCOME_REVIEW';
    summary: string;
  }
): Promise<void> => {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.contactId}, 1))`
  );
  const [existing] = await transaction
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.organisationId, input.organisationId),
        eq(tasks.contactId, input.contactId),
        eq(tasks.kind, input.kind),
        eq(tasks.status, 'OPEN')
      )
    )
    .limit(1);
  if (existing !== undefined) return;
  await transaction.insert(tasks).values({
    organisationId: input.organisationId,
    contactId: input.contactId,
    kind: input.kind,
    status: 'OPEN',
    summary: input.summary,
    createdAt: input.now,
    updatedAt: input.now
  });
};

const ensureVoiceReview = async (
  database: Database,
  input: Parameters<typeof ensureVoiceReviewInTransaction>[1]
): Promise<void> => {
  await database.transaction((transaction) =>
    ensureVoiceReviewInTransaction(transaction, input)
  );
};

const maxPendingReconciliations = 4;
const reconciliationDelayMs = 15 * 60 * 1000;

const schedulePendingReconciliation = async (
  dependencies: VoiceCallReconcileDependencies,
  input: {
    organisationId: string;
    voiceCallId: string;
    contactId: string;
    createCustomerReview: boolean;
    state: VoiceCallOperationalState;
    now: Date;
    correlationId?: string;
  }
): Promise<'scheduled' | 'exhausted'> => {
  const attempt = await dependencies.database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.voiceCallId}, 2))`
      );
      const priorAttempts = await transaction
        .select({ id: voiceCallEvents.id })
        .from(voiceCallEvents)
        .where(
          and(
            eq(voiceCallEvents.organisationId, input.organisationId),
            eq(voiceCallEvents.voiceCallId, input.voiceCallId),
            eq(
              voiceCallEvents.eventType,
              'VOICE_RECONCILIATION_PENDING'
            )
          )
        );
      if (priorAttempts.length >= maxPendingReconciliations) return null;
      const nextAttempt = priorAttempts.length + 1;
      await transaction
        .insert(voiceCallEvents)
        .values({
          organisationId: input.organisationId,
          voiceCallId: input.voiceCallId,
          providerEventKey: `reconcile:${input.voiceCallId}:pending:${nextAttempt}`,
          eventType: 'VOICE_RECONCILIATION_PENDING',
          safeState: input.state,
          safeMetadata: {
            attempt: nextAttempt,
            ...(input.correlationId === undefined
              ? {}
              : { correlationId: input.correlationId })
          },
          occurredAt: input.now,
          receivedAt: input.now
        })
        .onConflictDoNothing({
          target: [
            voiceCallEvents.organisationId,
            voiceCallEvents.provider,
            voiceCallEvents.providerEventKey
          ]
        });
      return nextAttempt;
    }
  );
  if (attempt === null && input.createCustomerReview) {
    await ensureVoiceReview(dependencies.database, {
      organisationId: input.organisationId,
      contactId: input.contactId,
      now: input.now,
      kind: 'VOICE_OUTCOME_REVIEW',
      summary: 'Review a voice call that remained in progress after reconciliation'
    });
    return 'exhausted';
  }
  await dependencies.publisher.publish(
    jobNames.voiceCallReconcile,
    {
      organisationId: input.organisationId,
      voiceCallId: input.voiceCallId,
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: input.correlationId })
    },
    {
      singletonKey: `voice-call-reconcile:${input.voiceCallId}:follow-up:${attempt}`,
      startAfter: new Date(input.now.getTime() + reconciliationDelayMs)
    }
  );
  return 'scheduled';
};

export async function reconcileVoiceCall(
  dependencies: VoiceCallReconcileDependencies,
  payload: VoiceCallReconcilePayload
): Promise<VoiceCallReconcileResult> {
  const now = dependencies.clock.now();
  const [call] = await dependencies.database
    .select()
    .from(voiceCallRequests)
    .where(
      and(
        eq(voiceCallRequests.organisationId, payload.organisationId),
        eq(voiceCallRequests.id, payload.voiceCallId)
      )
    )
    .limit(1);
  if (call === undefined) throw new Error('VOICE_CALL_NOT_FOUND');
  if (terminalStates.has(call.state)) {
    return { kind: 'existing', state: call.state };
  }
  if (call.providerCallId === null) {
    if (call.state === 'DRAFT' || call.state === 'APPROVED' || call.state === 'QUEUED') {
      return { kind: 'pending', state: call.state };
    }
    if (call.purpose === 'CUSTOMER') {
      await ensureVoiceReview(dependencies.database, {
        organisationId: payload.organisationId,
        contactId: call.contactId,
        now,
        kind: 'VOICE_OUTCOME_REVIEW',
        summary: 'Reconcile a voice call with no provider call identifier'
      });
    }
    return {
      kind: 'manual-review',
      reason: 'PROVIDER_CALL_ID_MISSING'
    };
  }

  const [settings] = await dependencies.database
    .select({ secretReference: organisationVoiceSettings.secretReference })
    .from(organisationVoiceSettings)
    .where(
      eq(organisationVoiceSettings.organisationId, payload.organisationId)
    )
    .limit(1);
  if (settings === undefined) throw new Error('VOICE_SETTINGS_NOT_FOUND');
  const apiKey = await dependencies.secrets.read(settings.secretReference);
  const provider = dependencies.providerFactory.create(apiKey);
  const status = await provider.getCall(call.providerCallId);
  if (status.callId !== call.providerCallId) {
    throw new Error('RETELL_CALL_ID_MISMATCH');
  }
  const occurredAt = providerTime(status, now);

  if (['ongoing', 'in_progress'].includes(status.callStatus.toLowerCase())) {
    if (call.state === 'ACCEPTED') {
      const transition = transitionVoiceCallState(
        { state: call.state, outcome: call.outcome },
        'CALL_STARTED'
      );
      if (transition.changed) {
        await dependencies.database
          .update(voiceCallRequests)
          .set({
            state: transition.state,
            outcome: transition.outcome,
            answeredAt: call.answeredAt ?? occurredAt,
            updatedAt: now
          })
          .where(
            and(
              eq(voiceCallRequests.organisationId, payload.organisationId),
              eq(voiceCallRequests.id, call.id),
              eq(voiceCallRequests.state, call.state)
            )
          );
      }
      const pending = await schedulePendingReconciliation(dependencies, {
        organisationId: payload.organisationId,
        voiceCallId: call.id,
        contactId: call.contactId,
        createCustomerReview: call.purpose === 'CUSTOMER',
        state: transition.state,
        now,
        ...(payload.correlationId === undefined
          ? {}
          : { correlationId: payload.correlationId })
      });
      return pending === 'exhausted'
        ? { kind: 'manual-review', reason: 'OUTCOME_INCOMPLETE' }
        : { kind: 'pending', state: transition.state };
    }
    const pending = await schedulePendingReconciliation(dependencies, {
      organisationId: payload.organisationId,
      voiceCallId: call.id,
      contactId: call.contactId,
      createCustomerReview: call.purpose === 'CUSTOMER',
      state: call.state,
      now,
      ...(payload.correlationId === undefined
        ? {}
        : { correlationId: payload.correlationId })
    });
    return pending === 'exhausted'
      ? { kind: 'manual-review', reason: 'OUTCOME_INCOMPLETE' }
      : { kind: 'pending', state: call.state };
  }

  const outcome = safeOutcome(status.analysis?.structuredOutcome);
  if (status.callStatus.toLowerCase() !== 'ended' || outcome === null) {
    if (call.purpose === 'CUSTOMER') {
      await ensureVoiceReview(dependencies.database, {
        organisationId: payload.organisationId,
        contactId: call.contactId,
        now,
        kind: 'VOICE_OUTCOME_REVIEW',
        summary: 'Review an incomplete voice-call reconciliation outcome'
      });
    }
    return { kind: 'manual-review', reason: 'OUTCOME_INCOMPLETE' };
  }

  const failed = ['INVALID_DESTINATION', 'PROVIDER_REJECTED'].includes(
    outcome
  );
  let reconciledState: 'COMPLETED' | 'FAILED';
  if (call.state === 'UNKNOWN') {
    const transition = transitionVoiceCallState(
      { state: call.state, outcome: call.outcome },
      failed ? 'RECONCILED_FAILED' : 'RECONCILED_COMPLETED'
    );
    reconciledState = transition.state as 'COMPLETED' | 'FAILED';
  } else {
    let current: VoiceCallState = {
      state: call.state,
      outcome: call.outcome
    };
    if (impliesAnswered(outcome) && current.state === 'ACCEPTED') {
      const started = transitionVoiceCallState(current, 'CALL_STARTED');
      current = { state: started.state, outcome: started.outcome };
    }
    if (outcome === 'REMINDER_DELIVERED') {
      const identity = transitionVoiceCallState(
        current,
        'IDENTITY_CONFIRMED'
      );
      current = { state: identity.state, outcome: identity.outcome };
      const delivered = transitionVoiceCallState(
        current,
        'REMINDER_DELIVERED'
      );
      current = { state: delivered.state, outcome: delivered.outcome };
    }
    const terminal = transitionVoiceCallState(
      current,
      terminalEventFor(outcome)
    );
    reconciledState = terminal.state as 'COMPLETED' | 'FAILED';
  }

  await dependencies.database.transaction(async (transaction) => {
    await transaction
      .update(voiceCallRequests)
      .set({
        state: reconciledState,
        outcome,
        ...(impliesAnswered(outcome) && call.answeredAt === null
          ? { answeredAt: occurredAt }
          : {}),
        completedAt: occurredAt,
        failureCode: failed ? outcome : null,
        updatedAt: now
      })
      .where(
        and(
          eq(voiceCallRequests.organisationId, payload.organisationId),
          eq(voiceCallRequests.id, call.id),
          eq(voiceCallRequests.state, call.state)
        )
      );
    await transaction
      .insert(voiceCallEvents)
      .values({
        organisationId: payload.organisationId,
        voiceCallId: call.id,
        providerEventKey: `reconcile:${call.id}:${reconciledState}:${outcome}`,
        eventType: 'VOICE_CALL_RECONCILED',
        safeState: reconciledState,
        safeOutcome: outcome,
        safeMetadata: {
          ...(payload.correlationId === undefined
            ? {}
            : { correlationId: payload.correlationId })
        },
        occurredAt,
        receivedAt: now
      })
      .onConflictDoNothing({
        target: [
          voiceCallEvents.organisationId,
          voiceCallEvents.provider,
          voiceCallEvents.providerEventKey
        ]
      });
    if (outcome === 'WRONG_PERSON' && call.purpose === 'CUSTOMER') {
      await transaction
        .insert(suppressions)
        .values({
          organisationId: payload.organisationId,
          channel: 'VOICE',
          normalisedDestination: call.destinationNumber,
          source: 'RETELL_RECONCILIATION',
          reason: 'Wrong-person voice outcome',
          consentState: 'SUPPRESSED',
          recordedAt: occurredAt
        })
        .onConflictDoUpdate({
          target: [
            suppressions.organisationId,
            suppressions.channel,
            suppressions.normalisedDestination
          ],
          set: {
            source: 'RETELL_RECONCILIATION',
            reason: 'Wrong-person voice outcome',
            consentState: 'SUPPRESSED',
            recordedAt: occurredAt
          }
        });
      await ensureVoiceReviewInTransaction(transaction, {
        organisationId: payload.organisationId,
        contactId: call.contactId,
        now,
        kind: 'VOICE_CONTACT_REVIEW',
        summary: 'Verify contact details after a wrong-person voice response'
      });
    }
  });
  return {
    kind: 'reconciled',
    state: reconciledState,
    outcome
  };
}
