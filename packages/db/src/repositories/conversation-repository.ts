import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { conversations, inboundMessages, operatorReplies, suppressions } from '../schema/messaging.js';
import { auditEvents } from '../schema/operations.js';
import { contacts } from '../schema/receivables.js';

export class PostgresConversationRepository {
  constructor(private readonly database: Database) {}

  list(organisationId: string) {
    return this.database.select({ conversation: conversations, contact: contacts }).from(conversations).innerJoin(contacts, eq(contacts.id, conversations.contactId)).where(eq(conversations.organisationId, organisationId)).orderBy(desc(conversations.lastMessageAt));
  }

  async thread(organisationId: string, conversationId: string) {
    const [conversation] = await this.database.select({ conversation: conversations, contact: contacts }).from(conversations).innerJoin(contacts, eq(contacts.id, conversations.contactId)).where(and(eq(conversations.organisationId, organisationId), eq(conversations.id, conversationId))).limit(1);
    if (conversation === undefined) return null;
    const [inbound, outbound, suppression] = await Promise.all([
      this.database.select().from(inboundMessages).where(and(eq(inboundMessages.organisationId, organisationId), eq(inboundMessages.conversationId, conversationId))).orderBy(asc(inboundMessages.receivedAt)),
      this.database.select().from(operatorReplies).where(and(eq(operatorReplies.organisationId, organisationId), eq(operatorReplies.conversationId, conversationId))).orderBy(asc(operatorReplies.createdAt)),
      this.database.select().from(suppressions).where(and(eq(suppressions.organisationId, organisationId), eq(suppressions.channel, 'SMS'), eq(suppressions.normalisedDestination, conversation.conversation.normalisedNumber), eq(suppressions.consentState, 'SUPPRESSED'))).limit(1)
    ]);
    return { ...conversation, inbound, outbound, suppression: suppression[0] ?? null };
  }

  async queueReply(input: { organisationId: string; conversationId: string; actorUserId: string; content: string; now: Date }): Promise<string> {
    return this.database.transaction(async (transaction) => {
      const [conversation] = await transaction.select().from(conversations).where(and(eq(conversations.organisationId, input.organisationId), eq(conversations.id, input.conversationId))).for('update').limit(1);
      if (conversation === undefined) throw new Error('CONVERSATION_NOT_FOUND');
      const [suppression] = await transaction.select().from(suppressions).where(and(eq(suppressions.organisationId, input.organisationId), eq(suppressions.channel, 'SMS'), eq(suppressions.normalisedDestination, conversation.normalisedNumber), eq(suppressions.consentState, 'SUPPRESSED'))).limit(1);
      if (suppression !== undefined) throw new Error(`SMS_SUPPRESSED:${suppression.source}`);
      const replyId = randomUUID();
      await transaction.insert(operatorReplies).values({ id: replyId, organisationId: input.organisationId, conversationId: input.conversationId, actorUserId: input.actorUserId, content: input.content, contentHash: createHash('sha256').update(input.content).digest('hex'), status: 'PENDING', idempotencyKey: `operator-reply:${replyId}`, createdAt: input.now, updatedAt: input.now });
      await transaction.update(conversations).set({ unreadCount: 0, assignedUserId: input.actorUserId, updatedAt: input.now }).where(eq(conversations.id, input.conversationId));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: input.actorUserId, eventType: 'OPERATOR_REPLY_QUEUED', entityType: 'CONVERSATION', entityId: input.conversationId, afterValue: { replyId, contentHash: createHash('sha256').update(input.content).digest('hex') }, occurredAt: input.now });
      return replyId;
    });
  }
}
