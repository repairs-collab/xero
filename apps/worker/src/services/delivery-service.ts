import { and, eq } from 'drizzle-orm';

import {
  type Database,
  messageAttempts,
  operatorReplies,
  outboundMessages,
  stageInstances
} from '@bc5000/db';
import type { SinchDeliveryEvent } from '@bc5000/integrations/sinch';

export async function processDeliveryEvent(
  database: Database,
  organisationId: string,
  event: SinchDeliveryEvent
): Promise<void> {
  await database.transaction(async (transaction) => {
    const [row] = await transaction
      .select({ attempt: messageAttempts, outbound: outboundMessages })
      .from(messageAttempts)
      .innerJoin(
        outboundMessages,
        eq(outboundMessages.id, messageAttempts.outboundMessageId)
      )
      .where(
        and(
          eq(messageAttempts.organisationId, organisationId),
          eq(messageAttempts.provider, 'SINCH'),
          eq(messageAttempts.providerMessageId, event.messageId)
        )
      )
      .for('update')
      .limit(1);
    if (row === undefined) {
      const [reply] = await transaction.select().from(operatorReplies).where(and(eq(operatorReplies.organisationId, organisationId), eq(operatorReplies.providerMessageId, event.messageId))).for('update').limit(1);
      if (reply === undefined) throw new Error('Sinch delivery message was not found');
      if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(reply.status) || event.category === 'nonterminal') return;
      const occurredAt = new Date(event.occurredAt);
      const delivered = event.category === 'delivered';
      await transaction.update(operatorReplies).set({ status: delivered ? 'DELIVERED' : 'FAILED', failureReason: delivered ? null : event.status, sentAt: occurredAt, updatedAt: occurredAt }).where(eq(operatorReplies.id, reply.id));
      return;
    }

    const terminal = ['DELIVERED', 'FAILED', 'CANCELLED'].includes(
      row.outbound.status
    );
    if (terminal) return;
    const occurredAt = new Date(event.occurredAt);

    if (event.category === 'nonterminal') {
      await transaction
        .update(messageAttempts)
        .set({ status: event.status, responseReceivedAt: occurredAt })
        .where(eq(messageAttempts.id, row.attempt.id));
      return;
    }

    const delivered = event.category === 'delivered';
    await transaction
      .update(messageAttempts)
      .set({
        status: delivered ? 'DELIVERED' : 'REJECTED',
        errorCode: delivered ? null : event.status,
        responseReceivedAt: occurredAt
      })
      .where(eq(messageAttempts.id, row.attempt.id));
    await transaction
      .update(outboundMessages)
      .set({
        status: delivered ? 'DELIVERED' : 'FAILED',
        completedAt: occurredAt,
        updatedAt: occurredAt
      })
      .where(eq(outboundMessages.id, row.outbound.id));
    await transaction
      .update(stageInstances)
      .set({
        status: delivered ? 'DELIVERED' : 'REJECTED',
        completedAt: occurredAt,
        updatedAt: occurredAt
      })
      .where(eq(stageInstances.id, row.outbound.stageInstanceId));
  });
}
