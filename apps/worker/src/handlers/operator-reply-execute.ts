import { and, eq } from 'drizzle-orm';

import { auditEvents, conversations, type Database, operatorReplies, organisations, suppressions } from '@bc5000/db';
import type { SinchSendSmsInput, SinchSubmitResult } from '@bc5000/integrations/sinch';
import type { JobPayloads } from '@bc5000/jobs';

export interface OperatorReplyDependencies {
  database: Database;
  clock: { now(): Date };
  sinch: { sendSms(input: SinchSendSmsInput): Promise<SinchSubmitResult> };
  callbackUrl: string;
}

export type OperatorReplyOutcome = { kind: 'dry-run' } | { kind: 'cancelled'; reason: 'SUPPRESSED' } | { kind: 'sent'; providerMessageId: string } | { kind: 'unknown' } | { kind: 'in-progress' };

export async function executeOperatorReply(dependencies: OperatorReplyDependencies, payload: JobPayloads['operator-reply.execute']): Promise<OperatorReplyOutcome> {
  const [row] = await dependencies.database.select({ reply: operatorReplies, conversation: conversations, organisation: organisations }).from(operatorReplies).innerJoin(conversations, eq(conversations.id, operatorReplies.conversationId)).innerJoin(organisations, eq(organisations.id, operatorReplies.organisationId)).where(and(eq(operatorReplies.organisationId, payload.organisationId), eq(operatorReplies.id, payload.replyId))).limit(1);
  if (row === undefined) throw new Error('OPERATOR_REPLY_NOT_FOUND');
  if (row.reply.status === 'DRY_RUN') return { kind: 'dry-run' };
  if (row.reply.status === 'ACCEPTED' || row.reply.status === 'DELIVERED') return { kind: 'sent', providerMessageId: row.reply.providerMessageId ?? '' };
  if (row.reply.status !== 'PENDING') return row.reply.status === 'UNKNOWN' ? { kind: 'unknown' } : { kind: 'in-progress' };
  const [suppression] = await dependencies.database.select().from(suppressions).where(and(eq(suppressions.organisationId, payload.organisationId), eq(suppressions.channel, 'SMS'), eq(suppressions.normalisedDestination, row.conversation.normalisedNumber), eq(suppressions.consentState, 'SUPPRESSED'))).limit(1);
  const now = dependencies.clock.now();
  if (suppression !== undefined) {
    await dependencies.database.update(operatorReplies).set({ status: 'CANCELLED', failureReason: `SUPPRESSED:${suppression.source}`, updatedAt: now }).where(eq(operatorReplies.id, row.reply.id));
    return { kind: 'cancelled', reason: 'SUPPRESSED' };
  }
  const claimed = await dependencies.database.update(operatorReplies).set({ status: 'SENDING', updatedAt: now }).where(and(eq(operatorReplies.id, row.reply.id), eq(operatorReplies.status, 'PENDING'))).returning({ id: operatorReplies.id });
  if (claimed.length === 0) return { kind: 'in-progress' };
  const liveAllowed = row.organisation.sendMode === 'live' && row.organisation.liveSendAcknowledged && row.organisation.recipientAllowlist.includes(row.conversation.normalisedNumber);
  if (!liveAllowed) {
    await dependencies.database.update(operatorReplies).set({ status: 'DRY_RUN', sentAt: now, updatedAt: now }).where(eq(operatorReplies.id, row.reply.id));
    await dependencies.database.insert(auditEvents).values({ organisationId: payload.organisationId, actorUserId: row.reply.actorUserId, eventType: 'OPERATOR_REPLY_DRY_RUN', entityType: 'CONVERSATION', entityId: row.conversation.id, afterValue: { replyId: row.reply.id }, occurredAt: now });
    return { kind: 'dry-run' };
  }
  try {
    const accepted = await dependencies.sinch.sendSms({ destinationNumber: row.conversation.normalisedNumber, content: row.reply.content, callbackUrl: dependencies.callbackUrl, metadata: { organisationId: payload.organisationId, operatorReplyId: row.reply.id, conversationId: row.conversation.id } });
    await dependencies.database.transaction(async (transaction) => {
      await transaction.update(operatorReplies).set({ status: 'ACCEPTED', providerMessageId: accepted.messageId, sentAt: now, updatedAt: now }).where(eq(operatorReplies.id, row.reply.id));
      await transaction.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, row.conversation.id));
      await transaction.insert(auditEvents).values({ organisationId: payload.organisationId, actorUserId: row.reply.actorUserId, eventType: 'OPERATOR_REPLY_ACCEPTED', entityType: 'CONVERSATION', entityId: row.conversation.id, afterValue: { replyId: row.reply.id, providerMessageId: accepted.messageId }, occurredAt: now });
    });
    return { kind: 'sent', providerMessageId: accepted.messageId };
  } catch {
    await dependencies.database.update(operatorReplies).set({ status: 'UNKNOWN', failureReason: 'UNKNOWN_SUBMISSION_OUTCOME', updatedAt: now }).where(eq(operatorReplies.id, row.reply.id));
    return { kind: 'unknown' };
  }
}
