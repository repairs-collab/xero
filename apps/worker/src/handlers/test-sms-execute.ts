import { and, eq } from 'drizzle-orm';

import {
  type Database,
  messageAttempts,
  organisations,
  outboundMessages,
  PostgresMessageRepository,
  suppressions
} from '@bc5000/db';
import {
  SinchAuthenticationFailure,
  SinchPermanentSubmissionFailure,
  SinchRateLimited,
  type SinchSendSmsInput,
  type SinchSubmitResult,
  SinchTransientFailure,
  SinchUnknownSubmissionOutcome,
  SinchValidationFailure
} from '@bc5000/integrations/sinch';
import type { JobPayloads } from '@bc5000/jobs';

import {
  loadProviderSendDecision,
  markProviderSendBlocked
} from '../services/provider-send-policy.js';

export interface TestSmsExecutionDependencies {
  database: Database;
  clock: { now(): Date };
  sinch: { sendSms(input: SinchSendSmsInput): Promise<SinchSubmitResult> };
  callbackUrl: string;
}

export type TestSmsOutcome =
  | { kind: 'dry-run' }
  | {
      kind: 'cancelled';
      reason:
        | 'SUPPRESSED'
        | 'OPERATIONAL_MAINTENANCE'
        | 'UNSUPPORTED_SENDING_STATE';
    }
  | { kind: 'sent'; providerMessageId: string }
  | { kind: 'rejected'; reason: 'PROVIDER_REJECTED' | 'RATE_LIMITED' }
  | { kind: 'unknown' }
  | { kind: 'in-progress' };

const outcomeFromStored = (input: {
  status: string;
  providerMessageId: string | null;
}): TestSmsOutcome => {
  if (input.status === 'DRY_RUN') return { kind: 'dry-run' };
  if (input.status === 'CANCELLED') {
    return { kind: 'cancelled', reason: 'SUPPRESSED' };
  }
  if (input.status === 'ACCEPTED' || input.status === 'DELIVERED') {
    return { kind: 'sent', providerMessageId: input.providerMessageId ?? '' };
  }
  if (input.status === 'FAILED') {
    return { kind: 'rejected', reason: 'PROVIDER_REJECTED' };
  }
  if (input.status === 'UNKNOWN') return { kind: 'unknown' };
  return { kind: 'in-progress' };
};

const isKnownRejection = (error: unknown): boolean =>
  error instanceof SinchValidationFailure ||
  error instanceof SinchAuthenticationFailure ||
  error instanceof SinchPermanentSubmissionFailure ||
  error instanceof SinchTransientFailure ||
  error instanceof SinchRateLimited;

export async function executeTestSms(
  dependencies: TestSmsExecutionDependencies,
  payload: JobPayloads['test-sms.execute']
): Promise<TestSmsOutcome> {
  const [candidate] = await dependencies.database
    .select({
      outbound: outboundMessages
    })
    .from(outboundMessages)
    .innerJoin(
      organisations,
      and(
        eq(organisations.id, outboundMessages.organisationId),
        eq(organisations.id, payload.organisationId)
      )
    )
    .where(
      and(
        eq(outboundMessages.organisationId, payload.organisationId),
        eq(outboundMessages.id, payload.outboundMessageId),
        eq(outboundMessages.source, 'TEST_SMS'),
        eq(outboundMessages.channel, 'SMS')
      )
    )
    .limit(1);
  if (candidate === undefined || candidate.outbound.content === null) {
    throw new Error('TEST_SMS_NOT_FOUND');
  }

  const now = dependencies.clock.now();
  const repository = new PostgresMessageRepository(dependencies.database);
  const claim = await repository.claimDirect({
    organisationId: payload.organisationId,
    outboundId: payload.outboundMessageId,
    provider: 'SINCH',
    now
  });
  if (claim.kind === 'existing') return outcomeFromStored(claim.outcome);
  if (claim.kind === 'blocked') {
    throw new Error('TEST_SMS_UNEXPECTED_WHITELIST_BLOCK');
  }

  const [suppression] = await dependencies.database
    .select()
    .from(suppressions)
    .where(
      and(
        eq(suppressions.organisationId, payload.organisationId),
        eq(suppressions.channel, 'SMS'),
        eq(
          suppressions.normalisedDestination,
          candidate.outbound.recipientKey
        ),
        eq(suppressions.consentState, 'SUPPRESSED')
      )
    )
    .limit(1);
  if (suppression !== undefined) {
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .update(messageAttempts)
        .set({
          status: 'CANCELLED',
          errorCode: `SUPPRESSED:${suppression.source}`,
          responseReceivedAt: now
        })
        .where(eq(messageAttempts.id, claim.attemptId));
      await transaction
        .update(outboundMessages)
        .set({
          status: 'CANCELLED',
          failureReason: `SUPPRESSED:${suppression.source}`,
          completedAt: now,
          updatedAt: now
        })
        .where(eq(outboundMessages.id, claim.outboundId));
    });
    return { kind: 'cancelled', reason: 'SUPPRESSED' };
  }

  const sendDecision = await loadProviderSendDecision(dependencies.database, {
    organisationId: payload.organisationId,
    source: 'TEST_SMS',
    channel: 'SMS',
    destination: candidate.outbound.recipientKey
  });
  if (sendDecision.kind === 'dry-run') {
    await repository.markDryRun({
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      stageInstanceId: null,
      now
    });
    return { kind: 'dry-run' };
  }
  if (sendDecision.kind === 'blocked') {
    await markProviderSendBlocked(dependencies.database, {
      organisationId: payload.organisationId,
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      stageInstanceId: null,
      reason: sendDecision.reason,
      now
    });
    return { kind: 'cancelled', reason: sendDecision.reason };
  }

  try {
    const accepted = await dependencies.sinch.sendSms({
      destinationNumber: candidate.outbound.recipientKey,
      content: candidate.outbound.content,
      callbackUrl: dependencies.callbackUrl,
      metadata: {
        organisationId: payload.organisationId,
        outboundMessageId: payload.outboundMessageId
      }
    });
    await repository.markAccepted({
      organisationId: payload.organisationId,
      stageInstanceId: null,
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      providerMessageId: accepted.messageId,
      providerPayload: { status: accepted.status },
      now
    });
    return { kind: 'sent', providerMessageId: accepted.messageId };
  } catch (error) {
    if (isKnownRejection(error)) {
      const reason =
        error instanceof SinchRateLimited ? 'RATE_LIMITED' : 'PROVIDER_REJECTED';
      await repository.markRejected({
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: null,
        errorCode: reason,
        now
      });
      return { kind: 'rejected', reason };
    }
    if (error instanceof SinchUnknownSubmissionOutcome || error instanceof Error) {
      await repository.markUnknown({
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: null,
        now
      });
      return { kind: 'unknown' };
    }
    throw error;
  }
}
