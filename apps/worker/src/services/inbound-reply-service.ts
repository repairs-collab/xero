import { createHash } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  auditEvents,
  contactChannels,
  conversations,
  type Database,
  inboundMessages,
  invoiceChases,
  outboundMessages,
  pauses,
  stageInstances,
  suppressions
} from '@bc5000/db';
import type {
  SinchOptOutEvent,
  SinchReplyEvent
} from '@bc5000/integrations/sinch';

const bodyHash = (body: string): string =>
  createHash('sha256').update(body).digest('hex');

const findContactByNumber = async (
  database: Database,
  organisationId: string,
  number: string
) => {
  const [channel] = await database
    .select({ contactId: contactChannels.contactId })
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.organisationId, organisationId),
        eq(contactChannels.kind, 'SMS'),
        eq(contactChannels.normalisedValue, number),
        eq(contactChannels.usable, true)
      )
    )
    .limit(1);
  return channel?.contactId ?? null;
};

export async function processInboundReply(
  database: Database,
  organisationId: string,
  event: SinchReplyEvent,
  providerPayload: Record<string, unknown>
): Promise<void> {
  const contactId = await findContactByNumber(
    database,
    organisationId,
    event.from
  );
  if (contactId === null) {
    throw new Error('Inbound reply number could not be matched to a customer');
  }
  const receivedAt = new Date(event.receivedAt);

  await database.transaction(async (transaction) => {
    const [conversation] = await transaction
      .insert(conversations)
      .values({
        organisationId,
        contactId,
        normalisedNumber: event.from,
        unreadCount: 1,
        lastMessageAt: receivedAt,
        updatedAt: receivedAt
      })
      .onConflictDoUpdate({
        target: [
          conversations.organisationId,
          conversations.contactId,
          conversations.normalisedNumber
        ],
        set: {
          unreadCount: sql`${conversations.unreadCount} + 1`,
          lastMessageAt: receivedAt,
          updatedAt: receivedAt
        }
      })
      .returning({ id: conversations.id });
    if (conversation === undefined) throw new Error('Conversation was not created');

    await transaction
      .insert(inboundMessages)
      .values({
        organisationId,
        conversationId: conversation.id,
        provider: 'SINCH',
        providerMessageId: event.replyId,
        body: event.content,
        bodyHash: bodyHash(event.content),
        providerPayload,
        receivedAt
      })
      .onConflictDoNothing({
        target: [
          inboundMessages.organisationId,
          inboundMessages.provider,
          inboundMessages.providerMessageId
        ]
      });

    const existingPause = await transaction
      .select({ id: pauses.id })
      .from(pauses)
      .where(
        and(
          eq(pauses.organisationId, organisationId),
          eq(pauses.kind, 'REPLY'),
          eq(pauses.scope, 'customer'),
          eq(pauses.contactId, contactId),
          eq(pauses.active, true)
        )
      )
      .limit(1);
    if (existingPause.length === 0) {
      await transaction.insert(pauses).values({
        organisationId,
        kind: 'REPLY',
        scope: 'customer',
        contactId,
        active: true,
        reason: 'Customer replied by SMS',
        startedAt: receivedAt
      });
    }
    await transaction
      .update(invoiceChases)
      .set({ status: 'PAUSED', updatedAt: receivedAt })
      .where(
        and(
          eq(invoiceChases.organisationId, organisationId),
          eq(invoiceChases.customerId, contactId),
          eq(invoiceChases.status, 'ACTIVE')
        )
      );
  });
}

export async function processOptOut(
  database: Database,
  organisationId: string,
  event: SinchOptOutEvent
): Promise<void> {
  const recordedAt = new Date(event.receivedAt);
  const contactId = await findContactByNumber(
    database,
    organisationId,
    event.from
  );
  await database.transaction(async (transaction) => {
    await transaction
      .insert(suppressions)
      .values({
        organisationId,
        channel: 'SMS',
        normalisedDestination: event.from,
        source: 'SINCH_OPT_OUT',
        reason: 'Recipient opted out through Sinch',
        consentState: 'SUPPRESSED',
        recordedAt
      })
      .onConflictDoUpdate({
        target: [
          suppressions.organisationId,
          suppressions.channel,
          suppressions.normalisedDestination
        ],
        set: {
          source: 'SINCH_OPT_OUT',
          reason: 'Recipient opted out through Sinch',
          consentState: 'SUPPRESSED',
          recordedAt
        }
      });

    if (contactId !== null) {
      await transaction
        .update(stageInstances)
        .set({ status: 'CANCELLED', completedAt: recordedAt, updatedAt: recordedAt })
        .where(
          and(
            eq(stageInstances.organisationId, organisationId),
            eq(stageInstances.channel, 'SMS'),
            inArray(stageInstances.status, [
              'CALCULATED',
              'AWAITING_APPROVAL',
              'SCHEDULED',
              'DUE',
              'PENDING_APPROVAL',
              'QUEUED'
            ]),
            sql`${stageInstances.invoiceChaseId} in (
              select ${invoiceChases.id}
              from ${invoiceChases}
              where ${invoiceChases.organisationId} = ${organisationId}
                and ${invoiceChases.customerId} = ${contactId}
            )`
          )
        );
    }
    await transaction
      .update(outboundMessages)
      .set({ status: 'CANCELLED', completedAt: recordedAt, updatedAt: recordedAt })
      .where(
        and(
          eq(outboundMessages.organisationId, organisationId),
          eq(outboundMessages.channel, 'SMS'),
          eq(outboundMessages.recipientKey, event.from),
          inArray(outboundMessages.status, ['PENDING', 'QUEUED'])
        )
      );
    await transaction.insert(auditEvents).values({
      organisationId,
      eventType: 'SMS_OPT_OUT',
      entityType: 'SMS_DESTINATION',
      entityId: bodyHash(event.from),
      afterValue: {
        consentState: 'SUPPRESSED',
        source: 'SINCH_OPT_OUT'
      },
      occurredAt: recordedAt
    });
  });
}
