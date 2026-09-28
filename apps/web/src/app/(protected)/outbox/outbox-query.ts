import {
  and,
  desc,
  eq,
  gte,
  ilike,
  lt,
  or,
  type SQL
} from 'drizzle-orm';

import {
  contacts,
  type Database,
  invoices,
  messageAttempts,
  outboundMessages,
  type OutboundSource,
  type OutboundStatus,
  users
} from '@bc5000/db/web';

export type OutboxChannel = 'SMS' | 'XERO_EMAIL';

export interface OutboxQueryInput {
  organisationId: string;
  search?: string;
  channel?: OutboxChannel;
  source?: OutboundSource;
  status?: OutboundStatus;
  from?: Date;
  before?: Date;
  cursor?: string;
  limit: number;
}

export interface OutboxRow {
  id: string;
  contactId: string | null;
  contactName: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  actorName: string | null;
  channel: OutboxChannel;
  source: OutboundSource;
  recipient: string;
  content: string | null;
  status: OutboundStatus;
  failureReason: string | null;
  provider: 'XERO' | 'SINCH' | null;
  providerMessageId: string | null;
  providerStatus: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

const encodeCursor = (row: Pick<OutboxRow, 'createdAt' | 'id'>): string =>
  Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })
  ).toString('base64url');

const decodeCursor = (value: string): DecodedCursor => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as { createdAt?: unknown; id?: unknown };
    const createdAt = new Date(
      typeof parsed.createdAt === 'string' ? parsed.createdAt : Number.NaN
    );
    if (
      Number.isNaN(createdAt.getTime()) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0
    ) {
      throw new Error('invalid cursor fields');
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new Error('INVALID_OUTBOX_CURSOR');
  }
};

const searchPattern = (value: string): string =>
  `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

export async function queryOutbox(
  database: Database,
  input: OutboxQueryInput
): Promise<{ rows: OutboxRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  const conditions: SQL[] = [
    eq(outboundMessages.organisationId, input.organisationId)
  ];
  if (input.channel !== undefined) {
    conditions.push(eq(outboundMessages.channel, input.channel));
  }
  if (input.source !== undefined) {
    conditions.push(eq(outboundMessages.source, input.source));
  }
  if (input.status !== undefined) {
    conditions.push(eq(outboundMessages.status, input.status));
  }
  if (input.from !== undefined) {
    conditions.push(gte(outboundMessages.createdAt, input.from));
  }
  if (input.before !== undefined) {
    conditions.push(lt(outboundMessages.createdAt, input.before));
  }
  if (input.search?.trim()) {
    const pattern = searchPattern(input.search.trim());
    conditions.push(
      or(
        ilike(outboundMessages.recipientKey, pattern),
        ilike(contacts.name, pattern),
        ilike(invoices.invoiceNumber, pattern)
      )!
    );
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    conditions.push(
      or(
        lt(outboundMessages.createdAt, cursor.createdAt),
        and(
          eq(outboundMessages.createdAt, cursor.createdAt),
          lt(outboundMessages.id, cursor.id)
        )
      )!
    );
  }

  const selected = await database
    .select({
      id: outboundMessages.id,
      contactId: outboundMessages.contactId,
      contactName: contacts.name,
      invoiceId: outboundMessages.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      actorName: users.displayName,
      channel: outboundMessages.channel,
      source: outboundMessages.source,
      recipient: outboundMessages.recipientKey,
      content: outboundMessages.content,
      status: outboundMessages.status,
      failureReason: outboundMessages.failureReason,
      provider: messageAttempts.provider,
      providerMessageId: messageAttempts.providerMessageId,
      providerStatus: messageAttempts.status,
      createdAt: outboundMessages.createdAt,
      completedAt: outboundMessages.completedAt
    })
    .from(outboundMessages)
    .leftJoin(
      contacts,
      and(
        eq(contacts.id, outboundMessages.contactId),
        eq(contacts.organisationId, input.organisationId)
      )
    )
    .leftJoin(
      invoices,
      and(
        eq(invoices.id, outboundMessages.invoiceId),
        eq(invoices.organisationId, input.organisationId)
      )
    )
    .leftJoin(users, eq(users.id, outboundMessages.actorUserId))
    .leftJoin(
      messageAttempts,
      and(
        eq(messageAttempts.organisationId, input.organisationId),
        eq(messageAttempts.outboundMessageId, outboundMessages.id),
        eq(messageAttempts.attemptNumber, 1)
      )
    )
    .where(and(...conditions))
    .orderBy(desc(outboundMessages.createdAt), desc(outboundMessages.id))
    .limit(limit + 1);

  const hasMore = selected.length > limit;
  const rows = selected.slice(0, limit) satisfies OutboxRow[];
  return {
    rows,
    nextCursor:
      hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]!) : null
  };
}
