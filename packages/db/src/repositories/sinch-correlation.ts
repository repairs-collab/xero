import { and, eq } from 'drizzle-orm';

import type { Database } from '../connection.js';
import {
  contacts,
  messageAttempts,
  organisations,
  outboundMessages
} from '../schema/index.js';
import { PostgresSmsCommerceRepository } from './sms-commerce-repository.js';

interface SinchCorrelationEvent {
  kind: 'reply' | 'opt-out' | 'delivery';
  accountId?: string;
  messageId?: string;
  from?: string;
  to?: string;
  receivedAt?: string;
  metadata?: Record<string, string>;
}

export type SinchSharedRoute =
  | { kind: 'legacy' }
  | { kind: 'ignored' }
  | { kind: 'pending' }
  | { kind: 'shared'; organisationId: string; contactId: string | null };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const e164Pattern = /^\+[1-9]\d{7,14}$/;

export async function resolveSharedSinchEvent(
  database: Database,
  event: SinchCorrelationEvent
): Promise<SinchSharedRoute> {
  const [account] = event.accountId === undefined
    ? []
    : await database
        .select({
          organisationId: organisations.id,
          linkedAt: organisations.sinchSharedAccountLinkedAt
        })
        .from(organisations)
        .where(eq(organisations.sinchSharedAccountId, event.accountId))
        .limit(1);
  const attempts = event.messageId === undefined
    ? []
    : await database
        .select({
          accountId: messageAttempts.sinchAccountId,
          attemptOrganisationId: messageAttempts.organisationId,
          organisationId: outboundMessages.organisationId,
          outboundId: outboundMessages.id,
          channel: outboundMessages.channel,
          recipient: outboundMessages.recipientKey,
          contactId: contacts.id
        })
        .from(messageAttempts)
        .innerJoin(
          outboundMessages,
          eq(messageAttempts.outboundMessageId, outboundMessages.id)
        )
        .leftJoin(
          contacts,
          and(
            eq(contacts.id, outboundMessages.contactId),
            eq(contacts.organisationId, outboundMessages.organisationId)
          )
        )
        .where(and(
          eq(messageAttempts.provider, 'SINCH'),
          eq(messageAttempts.providerMessageId, event.messageId)
        ));
  const outboundId = event.metadata?.outboundMessageId;
  if (!account) {
    if (attempts.some((attempt) => attempt.accountId !== null)) {
      return { kind: 'ignored' };
    }
    // A callback may arrive before its provider ID has been committed.
    // An echoed reference to a shared send must still never use legacy routing.
    if (
      outboundId !== undefined &&
      uuidPattern.test(outboundId) &&
      !attempts.some((attempt) => attempt.outboundId === outboundId)
    ) {
      const [referenced] = await database
        .select({ accountId: organisations.sinchSharedAccountId })
        .from(outboundMessages)
        .innerJoin(
          organisations,
          eq(outboundMessages.organisationId, organisations.id)
        )
        .where(and(
          eq(outboundMessages.id, outboundId),
          eq(outboundMessages.channel, 'SMS')
        ))
        .limit(1);
      if (referenced?.accountId) {
        return { kind: 'ignored' };
      }
    }
    return { kind: 'legacy' };
  }

  const claimedOrganisationId = event.metadata?.organisationId;
  if (
    account.linkedAt === null ||
    (claimedOrganisationId !== undefined && claimedOrganisationId !== account.organisationId) ||
    (outboundId !== undefined && !uuidPattern.test(outboundId))
  ) {
    return { kind: 'ignored' };
  }
  if (event.to !== undefined) {
    const destinationOrganisationId = await new PostgresSmsCommerceRepository(
      database
    ).findOrganisationIdByDestinationNumber(event.to);
    if (
      destinationOrganisationId !== null &&
      destinationOrganisationId !== account.organisationId
    ) {
      return { kind: 'ignored' };
    }
  }

  if (attempts.length === 0 && event.kind === 'opt-out') {
    const receivedAt = Date.parse(event.receivedAt ?? '');
    if (
      event.from === undefined ||
      !e164Pattern.test(event.from) ||
      !Number.isFinite(receivedAt) ||
      receivedAt < account.linkedAt.getTime()
    ) {
      return { kind: 'ignored' };
    }
    // Consent survives an operational reset even when it removes the send.
    // An existing reference must still agree with the account and subscriber.
    if (outboundId !== undefined) {
      const [referenced] = await database
        .select({
          organisationId: outboundMessages.organisationId,
          channel: outboundMessages.channel,
          recipient: outboundMessages.recipientKey
        })
        .from(outboundMessages)
        .where(eq(outboundMessages.id, outboundId))
        .limit(1);
      if (referenced && (
        referenced.organisationId !== account.organisationId ||
        referenced.channel !== 'SMS' ||
        referenced.recipient !== event.from
      )) {
        return { kind: 'ignored' };
      }
    }
    return {
      kind: 'shared',
      organisationId: account.organisationId,
      contactId: null
    };
  }
  if (event.messageId === undefined) return { kind: 'ignored' };
  // Sinch can deliver callbacks before the outbound worker commits the
  // provider message ID. Ask it to retry without entering legacy routing.
  if (attempts.length === 0) return { kind: 'pending' };

  const matching = attempts.filter(
    (attempt) =>
      attempt.accountId === event.accountId &&
      attempt.attemptOrganisationId === account.organisationId &&
      attempt.organisationId === account.organisationId &&
      attempt.channel === 'SMS'
  );
  const [attempt] = matching;
  if (
    matching.length !== 1 ||
    attempt === undefined ||
    (outboundId !== undefined && outboundId !== attempt.outboundId) ||
    ((event.kind !== 'delivery' || event.from !== undefined) &&
      event.from !== attempt.recipient) ||
    (event.kind === 'reply' && attempt.contactId === null)
  ) {
    return { kind: 'ignored' };
  }

  return {
    kind: 'shared',
    organisationId: attempt.organisationId,
    contactId: attempt.contactId
  };
}
