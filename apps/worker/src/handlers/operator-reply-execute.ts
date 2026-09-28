import { and, eq } from 'drizzle-orm';

import {
  auditEvents,
  conversations,
  type Database,
  operatorReplies,
  PostgresMessageRepository,
  suppressions
} from '@bc5000/db';
import type {
  SinchSendSmsInput,
  SinchSubmitResult
} from '@bc5000/integrations/sinch';
import type { JobPayloads } from '@bc5000/jobs';

import {
  loadProviderSendDecision,
  markProviderSendBlocked
} from '../services/provider-send-policy.js';

export interface OperatorReplyDependencies {
  database: Database;
  clock: { now(): Date };
  sinch: { sendSms(input: SinchSendSmsInput): Promise<SinchSubmitResult> };
  callbackUrl: string;
}

export type OperatorReplyOutcome =
  | { kind: 'dry-run' }
  | {
      kind: 'cancelled';
      reason:
        | 'SUPPRESSED'
        | 'OPERATIONAL_MAINTENANCE'
        | 'UNSUPPORTED_SENDING_STATE';
    }
  | { kind: 'sent'; providerMessageId: string }
  | { kind: 'unknown' }
  | { kind: 'in-progress' };

export async function executeOperatorReply(
  dependencies: OperatorReplyDependencies,
  payload: JobPayloads['operator-reply.execute']
): Promise<OperatorReplyOutcome> {
  const [row] = await dependencies.database
    .select({
      reply: operatorReplies,
      conversation: conversations
    })
    .from(operatorReplies)
    .innerJoin(
      conversations,
      eq(conversations.id, operatorReplies.conversationId)
    )
    .where(
      and(
        eq(operatorReplies.organisationId, payload.organisationId),
        eq(operatorReplies.id, payload.replyId)
      )
    )
    .limit(1);
  if (row === undefined) throw new Error('OPERATOR_REPLY_NOT_FOUND');
  if (row.reply.status === 'DRY_RUN') return { kind: 'dry-run' };
  if (row.reply.status === 'ACCEPTED' || row.reply.status === 'DELIVERED') {
    return {
      kind: 'sent',
      providerMessageId: row.reply.providerMessageId ?? ''
    };
  }
  if (row.reply.status !== 'PENDING') {
    return row.reply.status === 'UNKNOWN'
      ? { kind: 'unknown' }
      : { kind: 'in-progress' };
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
          row.conversation.normalisedNumber
        ),
        eq(suppressions.consentState, 'SUPPRESSED')
      )
    )
    .limit(1);
  const now = dependencies.clock.now();
  if (suppression !== undefined) {
    await dependencies.database
      .update(operatorReplies)
      .set({
        status: 'CANCELLED',
        failureReason: `SUPPRESSED:${suppression.source}`,
        updatedAt: now
      })
      .where(eq(operatorReplies.id, row.reply.id));
    return { kind: 'cancelled', reason: 'SUPPRESSED' };
  }

  const messages = new PostgresMessageRepository(dependencies.database);
  const queued = await messages.queueDirect({
    organisationId: payload.organisationId,
    contactId: row.conversation.contactId,
    actorUserId: row.reply.actorUserId,
    channel: 'SMS',
    source: 'INBOX_REPLY',
    recipientKey: row.conversation.normalisedNumber,
    content: row.reply.content,
    contentHash: row.reply.contentHash,
    idempotencyKey: row.reply.idempotencyKey,
    now
  });
  await dependencies.database
    .update(operatorReplies)
    .set({ outboundMessageId: queued.outboundId, updatedAt: now })
    .where(eq(operatorReplies.id, row.reply.id));
  const claim = await messages.claimDirect({
    organisationId: payload.organisationId,
    outboundId: queued.outboundId,
    provider: 'SINCH',
    now
  });
  if (claim.kind === 'blocked') throw new Error('DIRECT_MESSAGE_BLOCKED');
  if (claim.kind === 'existing') {
    if (claim.outcome.status === 'DRY_RUN') return { kind: 'dry-run' };
    if (
      claim.outcome.status === 'ACCEPTED' ||
      claim.outcome.status === 'DELIVERED'
    ) {
      return {
        kind: 'sent',
        providerMessageId: claim.outcome.providerMessageId ?? ''
      };
    }
    if (claim.outcome.status === 'UNKNOWN') return { kind: 'unknown' };
    return { kind: 'in-progress' };
  }

  await dependencies.database
    .update(operatorReplies)
    .set({ status: 'SENDING', updatedAt: now })
    .where(eq(operatorReplies.id, row.reply.id));
  const sendDecision = await loadProviderSendDecision(dependencies.database, {
    organisationId: payload.organisationId,
    source: 'INBOX_REPLY',
    channel: 'SMS',
    destination: row.conversation.normalisedNumber
  });
  if (sendDecision.kind === 'dry-run') {
    await messages.markDryRun({
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      stageInstanceId: null,
      now
    });
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .update(operatorReplies)
        .set({ status: 'DRY_RUN', sentAt: now, updatedAt: now })
        .where(eq(operatorReplies.id, row.reply.id));
      await transaction.insert(auditEvents).values({
        organisationId: payload.organisationId,
        actorUserId: row.reply.actorUserId,
        eventType: 'OPERATOR_REPLY_DRY_RUN',
        entityType: 'CONVERSATION',
        entityId: row.conversation.id,
        afterValue: {
          replyId: row.reply.id,
          outboundMessageId: claim.outboundId
        },
        occurredAt: now
      });
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
    await dependencies.database
      .update(operatorReplies)
      .set({
        status: 'CANCELLED',
        failureReason: sendDecision.reason,
        updatedAt: now
      })
      .where(eq(operatorReplies.id, row.reply.id));
    return { kind: 'cancelled', reason: sendDecision.reason };
  }

  try {
    const accepted = await dependencies.sinch.sendSms({
      destinationNumber: row.conversation.normalisedNumber,
      content: row.reply.content,
      callbackUrl: dependencies.callbackUrl,
      metadata: {
        organisationId: payload.organisationId,
        operatorReplyId: row.reply.id,
        conversationId: row.conversation.id,
        outboundMessageId: claim.outboundId
      }
    });
    await messages.markAccepted({
      organisationId: payload.organisationId,
      stageInstanceId: null,
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      providerMessageId: accepted.messageId,
      providerPayload: { status: accepted.status },
      now
    });
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .update(operatorReplies)
        .set({
          status: 'ACCEPTED',
          providerMessageId: accepted.messageId,
          sentAt: now,
          updatedAt: now
        })
        .where(eq(operatorReplies.id, row.reply.id));
      await transaction
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, row.conversation.id));
      await transaction.insert(auditEvents).values({
        organisationId: payload.organisationId,
        actorUserId: row.reply.actorUserId,
        eventType: 'OPERATOR_REPLY_ACCEPTED',
        entityType: 'CONVERSATION',
        entityId: row.conversation.id,
        afterValue: {
          replyId: row.reply.id,
          outboundMessageId: claim.outboundId,
          providerMessageId: accepted.messageId
        },
        occurredAt: now
      });
    });
    return { kind: 'sent', providerMessageId: accepted.messageId };
  } catch {
    await messages.markUnknown({
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      stageInstanceId: null,
      now
    });
    await dependencies.database
      .update(operatorReplies)
      .set({
        status: 'UNKNOWN',
        failureReason: 'UNKNOWN_SUBMISSION_OUTCOME',
        updatedAt: now
      })
      .where(eq(operatorReplies.id, row.reply.id));
    return { kind: 'unknown' };
  }
}
