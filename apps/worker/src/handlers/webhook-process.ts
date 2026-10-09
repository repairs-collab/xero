import { and, desc, eq, sql } from 'drizzle-orm';

import {
  type Database,
  type DbTransaction,
  operationalResetRuns,
  organisations,
  suppressions,
  tasks,
  voiceCallEvents,
  voiceCallRequests,
  webhookEvents
} from '@bc5000/db';
import {
  transitionVoiceCallState,
  type VoiceCallEvent,
  type VoiceCallOperationalState,
  type VoiceCallOutcome
} from '@bc5000/domain';
import {
  parseRetellWebhook,
  type RetellStructuredOutcome,
  type RetellWebhookEvent
} from '@bc5000/integrations/retell';
import { parseSinchEvent } from '@bc5000/integrations/sinch';
import {
  jobNames,
  type JobPayloads,
  type JobPublisher
} from '@bc5000/jobs';

import { processDeliveryEvent } from '../services/delivery-service.js';
import {
  processInboundReply,
  processOptOut
} from '../services/inbound-reply-service.js';

export interface WebhookProcessDependencies {
  database: Database;
  publisher: JobPublisher;
}

type JsonRecord = Record<string, unknown>;

const rawBodyFrom = (payload: Record<string, unknown>): string => {
  const rawBody = payload.rawBody;
  if (typeof rawBody !== 'string') {
    throw new Error('Stored webhook has no raw body');
  }
  return rawBody;
};

const parseRecord = (rawBody: string): JsonRecord => {
  const parsed = JSON.parse(rawBody) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Stored webhook payload is malformed');
  }
  return parsed as JsonRecord;
};

const processXeroEvent = async (
  dependencies: WebhookProcessDependencies,
  event: typeof webhookEvents.$inferSelect,
  rawBody: string
): Promise<void> => {
  const payload = parseRecord(rawBody);
  if (!Array.isArray(payload.events)) {
    throw new Error('Stored Xero webhook has no events');
  }
  const matching = (payload.events as JsonRecord[]).find((candidate) => {
    if (
      typeof candidate.resourceId !== 'string' ||
      typeof candidate.eventType !== 'string' ||
      typeof candidate.eventDateUtc !== 'string'
    ) {
      return false;
    }
    return (
      `${candidate.resourceId}:${candidate.eventType}:${candidate.eventDateUtc}` ===
      event.providerEventId
    );
  });
  if (matching === undefined || typeof matching.resourceId !== 'string') {
    throw new Error('Stored Xero event could not be matched');
  }
  await dependencies.publisher.publish(
    jobNames.xeroInvoiceRefresh,
    {
      organisationId: event.organisationId,
      invoiceId: matching.resourceId,
      webhookEventId: event.id
    },
    {
      singletonKey: `xero.invoice-refresh:${event.organisationId}:${matching.resourceId}:${event.id}`
    }
  );
};

interface VoiceMilestone {
  domainEvent?: VoiceCallEvent;
  eventType: string;
}

const startedMilestone: VoiceMilestone = {
  domainEvent: 'CALL_STARTED',
  eventType: 'VOICE_CALL_STARTED'
};

const terminalMilestone = (
  event: VoiceCallEvent,
  eventType: string
): VoiceMilestone => ({ domainEvent: event, eventType });

const outcomeIsContradictory = (
  outcome: RetellStructuredOutcome
): boolean => {
  const wrongPerson = outcome.wrongPerson === true || outcome.finalResult === 'wrong_person';
  const voicemail = outcome.voicemailLeft === true || outcome.finalResult === 'voicemail_left';
  const identityConfirmed = outcome.identityResult === 'confirmed';
  const identityRejected = outcome.identityResult === 'not_confirmed';
  const financialOrTransfer =
    outcome.finalResult === 'details_delivered' ||
    outcome.finalResult === 'transferred' ||
    outcome.finalResult === 'transfer_unanswered' ||
    outcome.transferRequested === true ||
    outcome.transferResult !== undefined;
  return (
    (wrongPerson && (identityConfirmed || identityRejected || voicemail || financialOrTransfer)) ||
    (voicemail && (identityConfirmed || identityRejected || financialOrTransfer)) ||
    (identityRejected && financialOrTransfer) ||
    (outcome.finalResult === 'transferred' && outcome.transferResult !== 'bridged') ||
    (outcome.finalResult === 'transfer_unanswered' &&
      !['unanswered', 'failed'].includes(outcome.transferResult ?? ''))
  );
};

const analyzedMilestones = (
  outcome: RetellStructuredOutcome
): {
  milestones: VoiceMilestone[];
  wrongPerson: boolean;
  needsReview: boolean;
} => {
  const wrongPerson = outcome.wrongPerson === true || outcome.finalResult === 'wrong_person';
  const voicemail = outcome.voicemailLeft === true || outcome.finalResult === 'voicemail_left';
  const contradictory = outcomeIsContradictory(outcome);
  if (wrongPerson) {
    return {
      milestones: [
        startedMilestone,
        terminalMilestone('WRONG_PERSON', 'VOICE_WRONG_PERSON_REPORTED')
      ],
      wrongPerson: true,
      needsReview: contradictory
    };
  }
  if (voicemail) {
    return {
      milestones: [terminalMilestone('VOICEMAIL_LEFT', 'VOICE_VOICEMAIL_LEFT')],
      wrongPerson: false,
      needsReview: contradictory
    };
  }
  if (outcome.identityResult === 'not_confirmed') {
    return {
      milestones: [
        startedMilestone,
        terminalMilestone(
          'IDENTITY_NOT_CONFIRMED',
          'VOICE_IDENTITY_NOT_CONFIRMED'
        )
      ],
      wrongPerson: false,
      needsReview: contradictory
    };
  }

  const milestones: VoiceMilestone[] = [];
  const conversational =
    outcome.identityResult === 'confirmed' ||
    outcome.transferRequested === true ||
    outcome.transferResult !== undefined ||
    ['details_delivered', 'transferred', 'transfer_unanswered'].includes(
      outcome.finalResult ?? ''
    );
  if (conversational) milestones.push(startedMilestone);
  if (outcome.identityResult === 'confirmed') {
    milestones.push({
      domainEvent: 'IDENTITY_CONFIRMED',
      eventType: 'VOICE_IDENTITY_CONFIRMED'
    });
  }

  const detailsDelivered =
    outcome.identityResult === 'confirmed' &&
    (outcome.finalResult === 'details_delivered' ||
      outcome.finalResult === 'transferred' ||
      outcome.finalResult === 'transfer_unanswered');
  if (detailsDelivered) {
    milestones.push({
      domainEvent: 'REMINDER_DELIVERED',
      eventType: 'VOICE_REMINDER_DELIVERED'
    });
  }
  if (outcome.transferRequested === true) {
    milestones.push({
      domainEvent: 'TRANSFER_REQUESTED',
      eventType: 'VOICE_TRANSFER_REQUESTED'
    });
  }

  switch (outcome.finalResult) {
    case 'details_delivered':
      if (detailsDelivered) {
        milestones.push({
          domainEvent: 'CALL_ENDED',
          eventType: 'VOICE_CALL_COMPLETED'
        });
      }
      break;
    case 'transferred':
      milestones.push(terminalMilestone('TRANSFERRED', 'VOICE_TRANSFERRED'));
      break;
    case 'transfer_unanswered':
      milestones.push(
        terminalMilestone(
          'TRANSFER_UNANSWERED',
          'VOICE_TRANSFER_UNANSWERED'
        )
      );
      break;
    case 'no_answer':
      milestones.push(terminalMilestone('NO_ANSWER', 'VOICE_NO_ANSWER'));
      break;
    case 'busy':
      milestones.push(terminalMilestone('BUSY', 'VOICE_BUSY'));
      break;
    case 'invalid_destination':
      milestones.push(
        terminalMilestone(
          'INVALID_DESTINATION',
          'VOICE_INVALID_DESTINATION'
        )
      );
      break;
    case 'provider_rejected':
      milestones.push(
        terminalMilestone('PROVIDER_REJECTED', 'VOICE_CALL_FAILED')
      );
      break;
    default:
      break;
  }
  const conclusive = outcome.finalResult !== undefined;
  return {
    milestones,
    wrongPerson: false,
    needsReview: contradictory || !conclusive
  };
};

const knownEndedMilestone = (
  disconnectionReason: string | undefined
): VoiceMilestone | null => {
  switch (disconnectionReason?.toLowerCase()) {
    case 'no_answer':
    case 'dial_no_answer':
      return terminalMilestone('NO_ANSWER', 'VOICE_NO_ANSWER');
    case 'busy':
    case 'dial_busy':
      return terminalMilestone('BUSY', 'VOICE_BUSY');
    case 'invalid_destination':
    case 'invalid_number':
      return terminalMilestone(
        'INVALID_DESTINATION',
        'VOICE_INVALID_DESTINATION'
      );
    case 'provider_rejected':
      return terminalMilestone('PROVIDER_REJECTED', 'VOICE_CALL_FAILED');
    default:
      return null;
  }
};

const retellOccurredAt = (
  event: RetellWebhookEvent,
  fallback: Date
): Date => {
  const timestamp =
    event.eventType === 'call_started'
      ? event.startTimestamp
      : event.endTimestamp ?? event.startTimestamp;
  if (timestamp === undefined) return fallback;
  const occurredAt = new Date(timestamp);
  return Number.isFinite(occurredAt.getTime()) ? occurredAt : fallback;
};

const ensureVoiceReviewTask = async (
  transaction: DbTransaction,
  input: {
    organisationId: string;
    contactId: string;
    kind: 'VOICE_CONTACT_REVIEW' | 'VOICE_OUTCOME_REVIEW';
    summary: string;
    now: Date;
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
    kind: input.kind,
    contactId: input.contactId,
    status: 'OPEN',
    summary: input.summary,
    createdAt: input.now,
    updatedAt: input.now
  });
};

const processRetellEvent = async (
  dependencies: WebhookProcessDependencies,
  stored: typeof webhookEvents.$inferSelect,
  rawBody: string
): Promise<void> => {
  const providerEvent = parseRetellWebhook(Buffer.from(rawBody));
  if (providerEvent.eventKey !== stored.providerEventId) {
    throw new Error('RETELL_WEBHOOK_EVENT_MISMATCH');
  }
  const occurredAt = retellOccurredAt(providerEvent, stored.receivedAt);
  await dependencies.database.transaction(async (transaction) => {
    const [call] = await transaction
      .select()
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, stored.organisationId),
          eq(voiceCallRequests.provider, 'RETELL'),
          eq(voiceCallRequests.providerCallId, providerEvent.callId)
        )
      )
      .for('update')
      .limit(1);
    if (call === undefined) throw new Error('VOICE_CALL_NOT_FOUND');

    let current: {
      state: VoiceCallOperationalState;
      outcome: VoiceCallOutcome | null;
    } = { state: call.state, outcome: call.outcome };
    let answered = call.answeredAt !== null;

    const append = async (
      suffix: string,
      eventType: string,
      domainEvent?: VoiceCallEvent
    ): Promise<void> => {
      const mayApply =
        domainEvent !== 'CALL_STARTED' || current.state === 'ACCEPTED';
      const transition =
        domainEvent === undefined || !mayApply
          ? { ...current, changed: false }
          : transitionVoiceCallState(current, domainEvent);
      const inserted = await transaction
        .insert(voiceCallEvents)
        .values({
          organisationId: stored.organisationId,
          voiceCallId: call.id,
          providerEventKey: `${providerEvent.eventKey}:${suffix}`,
          eventType,
          safeState: transition.state,
          safeOutcome: transition.outcome,
          occurredAt,
          receivedAt: stored.receivedAt
        })
        .onConflictDoNothing({
          target: [
            voiceCallEvents.organisationId,
            voiceCallEvents.provider,
            voiceCallEvents.providerEventKey
          ]
        })
        .returning({ id: voiceCallEvents.id });
      if (inserted.length === 0 || !transition.changed) return;
      current = { state: transition.state, outcome: transition.outcome };
      if (
        domainEvent === 'CALL_STARTED' ||
        domainEvent === 'IDENTITY_CONFIRMED' ||
        domainEvent === 'IDENTITY_NOT_CONFIRMED' ||
        domainEvent === 'WRONG_PERSON' ||
        domainEvent === 'TRANSFER_REQUESTED' ||
        domainEvent === 'TRANSFERRED' ||
        domainEvent === 'TRANSFER_UNANSWERED'
      ) {
        answered = true;
      }
    };

    let wrongPerson = false;
    let needsReview = false;
    if (providerEvent.eventType === 'call_started') {
      await append('started', 'VOICE_CALL_STARTED', 'CALL_STARTED');
    } else if (providerEvent.eventType === 'call_ended') {
      await append('ended-observed', 'VOICE_CALL_ENDED');
      const ended = knownEndedMilestone(providerEvent.disconnectionReason);
      if (ended !== null) {
        await append(
          `outcome-${ended.domainEvent}`,
          ended.eventType,
          ended.domainEvent
        );
      }
    } else {
      await append('analyzed', 'VOICE_CALL_ANALYZED');
      const normalized = analyzedMilestones(
        providerEvent.analysis?.structuredOutcome ?? {}
      );
      wrongPerson = normalized.wrongPerson;
      needsReview = normalized.needsReview;
      for (const [index, milestone] of normalized.milestones.entries()) {
        await append(
          `milestone-${index}-${milestone.domainEvent ?? 'observed'}`,
          milestone.eventType,
          milestone.domainEvent
        );
      }
    }

    if (wrongPerson && call.purpose === 'CUSTOMER') {
      await transaction
        .insert(suppressions)
        .values({
          organisationId: stored.organisationId,
          channel: 'VOICE',
          normalisedDestination: call.destinationNumber,
          source: 'RETELL_WRONG_PERSON',
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
            source: 'RETELL_WRONG_PERSON',
            reason: 'Wrong-person voice outcome',
            consentState: 'SUPPRESSED',
            recordedAt: occurredAt
          }
        });
      await ensureVoiceReviewTask(transaction, {
        organisationId: stored.organisationId,
        contactId: call.contactId,
        kind: 'VOICE_CONTACT_REVIEW',
        summary: 'Review voice contact after a wrong-person outcome',
        now: stored.receivedAt
      });
    }
    if (needsReview && call.purpose === 'CUSTOMER') {
      await ensureVoiceReviewTask(transaction, {
        organisationId: stored.organisationId,
        contactId: call.contactId,
        kind: 'VOICE_OUTCOME_REVIEW',
        summary: 'Review an incomplete or contradictory voice-call outcome',
        now: stored.receivedAt
      });
    }

    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(
      current.state
    );
    await transaction
      .update(voiceCallRequests)
      .set({
        state: current.state,
        outcome: current.outcome,
        ...(answered && call.answeredAt === null
          ? { answeredAt: occurredAt }
          : {}),
        ...(terminal && call.completedAt === null
          ? { completedAt: occurredAt }
          : {}),
        ...(current.state === 'FAILED'
          ? { failureCode: current.outcome ?? 'PROVIDER_FAILED' }
          : {}),
        updatedAt: stored.receivedAt
      })
      .where(
        and(
          eq(voiceCallRequests.organisationId, stored.organisationId),
          eq(voiceCallRequests.id, call.id)
        )
      );
  });
};

export async function processWebhookEvent(
  dependencies: WebhookProcessDependencies,
  payload: JobPayloads['webhook.process']
): Promise<void> {
  const [stored] = await dependencies.database
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.organisationId, payload.organisationId),
        eq(webhookEvents.id, payload.webhookEventId),
        eq(webhookEvents.provider, payload.provider)
      )
    )
    .limit(1);
  if (stored === undefined) throw new Error('Webhook event was not found');
  if (stored.processedAt !== null) return;
  if (!stored.signatureValid) throw new Error('Refusing an unverified webhook');

  const [latestCompletedReset] = await dependencies.database
    .select({ completedAt: operationalResetRuns.completedAt })
    .from(operationalResetRuns)
    .where(
      and(
        eq(operationalResetRuns.organisationId, payload.organisationId),
        eq(operationalResetRuns.status, 'COMPLETED')
      )
    )
    .orderBy(desc(operationalResetRuns.completedAt))
    .limit(1);
  if (
    latestCompletedReset?.completedAt !== null &&
    latestCompletedReset?.completedAt !== undefined &&
    stored.receivedAt <= latestCompletedReset.completedAt
  ) {
    if (stored.provider === 'SINCH') {
      const event = (() => {
        try {
          const rawBody = rawBodyFrom(stored.providerPayload);
          return parseSinchEvent(Buffer.from(rawBody));
        } catch {
          return undefined;
        }
      })();
      if (event?.kind === 'opt-out') {
        await processOptOut(
          dependencies.database,
          stored.organisationId,
          event
        );
        await dependencies.database
          .update(webhookEvents)
          .set({
            processedAt: new Date(),
            processingAttempts: sql`${webhookEvents.processingAttempts} + 1`,
            processingError: null
          })
          .where(eq(webhookEvents.id, stored.id));
        return;
      }
    }
    await dependencies.database
      .update(webhookEvents)
      .set({
        processedAt: new Date(),
        processingAttempts: sql`${webhookEvents.processingAttempts} + 1`,
        processingError: 'IGNORED_PRE_RESET_EVENT'
      })
      .where(eq(webhookEvents.id, stored.id));
    return;
  }

  if (stored.provider === 'XERO') {
    const [organisation] = await dependencies.database
      .select({
        operationalState: organisations.operationalState
      })
      .from(organisations)
      .where(eq(organisations.id, stored.organisationId))
      .limit(1);
    if (
      organisation === undefined ||
      organisation.operationalState === 'RESET_PREPARING' ||
      organisation.operationalState === 'RESET_IN_PROGRESS' ||
      organisation.operationalState === 'SYNC_REQUIRED'
    ) {
      await dependencies.database
        .update(webhookEvents)
        .set({
          processedAt: new Date(),
          processingAttempts: sql`${webhookEvents.processingAttempts} + 1`,
          processingError: 'IGNORED_PENDING_FRESH_SYNC'
        })
        .where(eq(webhookEvents.id, stored.id));
      return;
    }
  }

  await dependencies.database
    .update(webhookEvents)
    .set({
      processingAttempts: sql`${webhookEvents.processingAttempts} + 1`,
      processingError: null
    })
    .where(eq(webhookEvents.id, stored.id));

  try {
    const rawBody = rawBodyFrom(stored.providerPayload);
    if (stored.provider === 'XERO') {
      await processXeroEvent(dependencies, stored, rawBody);
    } else if (stored.provider === 'SINCH') {
      const event = parseSinchEvent(Buffer.from(rawBody));
      const providerPayload = parseRecord(rawBody);
      if (event.kind === 'reply') {
        await processInboundReply(
          dependencies.database,
          stored.organisationId,
          event,
          providerPayload
        );
      } else if (event.kind === 'opt-out') {
        await processOptOut(
          dependencies.database,
          stored.organisationId,
          event
        );
      } else {
        await processDeliveryEvent(
          dependencies.database,
          stored.organisationId,
          event
        );
      }
    } else {
      await processRetellEvent(dependencies, stored, rawBody);
    }
    await dependencies.database
      .update(webhookEvents)
      .set({ processedAt: new Date(), processingError: null })
      .where(eq(webhookEvents.id, stored.id));
  } catch (error) {
    await dependencies.database
      .update(webhookEvents)
      .set({
        processingError:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : 'Unknown webhook processing error'
      })
      .where(eq(webhookEvents.id, stored.id));
    throw error;
  }
}
