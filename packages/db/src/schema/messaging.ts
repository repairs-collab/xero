import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations, users } from './organisation.js';
import { contacts } from './receivables.js';
import { stageInstances } from './reminders.js';

export type OutboundStatus =
  | 'PENDING'
  | 'DRY_RUN'
  | 'QUEUED'
  | 'SENDING'
  | 'ACCEPTED'
  | 'DELIVERED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED';

export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    stageInstanceId: uuid('stage_instance_id')
      .notNull()
      .references(() => stageInstances.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 })
      .$type<'SMS' | 'XERO_EMAIL'>()
      .notNull(),
    recipientKey: text('recipient_key').notNull(),
    sourceVersion: integer('source_version').notNull(),
    contentHash: text('content_hash'),
    status: varchar('status', { length: 24 })
      .$type<OutboundStatus>()
      .notNull()
      .default('PENDING'),
    idempotencyKey: text('idempotency_key').notNull(),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('outbound_messages_org_idempotency_uq').on(
      table.organisationId,
      table.idempotencyKey
    ),
    index('outbound_messages_status_idx').on(
      table.organisationId,
      table.status,
      table.createdAt
    )
  ]
);

export const messageAttempts = pgTable(
  'message_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    outboundMessageId: uuid('outbound_message_id')
      .notNull()
      .references(() => outboundMessages.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    provider: varchar('provider', { length: 16 })
      .$type<'XERO' | 'SINCH'>()
      .notNull(),
    providerMessageId: text('provider_message_id'),
    status: varchar('status', { length: 24 }).notNull(),
    requestDispatchedAt: timestamp('request_dispatched_at', {
      withTimezone: true
    }),
    responseReceivedAt: timestamp('response_received_at', {
      withTimezone: true
    }),
    providerPayload: jsonb('provider_payload').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('message_attempts_outbound_number_uq').on(
      table.organisationId,
      table.outboundMessageId,
      table.attemptNumber
    ),
    uniqueIndex('message_attempts_org_provider_message_uq').on(
      table.organisationId,
      table.provider,
      table.providerMessageId
    )
  ]
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    normalisedNumber: text('normalised_number').notNull(),
    assignedUserId: uuid('assigned_user_id').references(() => users.id),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', {
      withTimezone: true
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('conversations_org_contact_number_uq').on(
      table.organisationId,
      table.contactId,
      table.normalisedNumber
    ),
    index('conversations_recency_idx').on(
      table.organisationId,
      table.lastMessageAt
    )
  ]
);

export const inboundMessages = pgTable(
  'inbound_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 })
      .$type<'SINCH'>()
      .notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    body: text('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    providerPayload: jsonb('provider_payload')
      .$type<Record<string, unknown>>()
      .notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('inbound_messages_org_provider_message_uq').on(
      table.organisationId,
      table.provider,
      table.providerMessageId
    )
  ]
);

export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 })
      .$type<'SMS' | 'XERO_EMAIL'>()
      .notNull(),
    normalisedDestination: text('normalised_destination').notNull(),
    source: varchar('source', { length: 32 }).notNull(),
    reason: text('reason').notNull(),
    consentState: varchar('consent_state', { length: 24 })
      .$type<'SUPPRESSED' | 'RECONSENTED'>()
      .notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('suppressions_org_channel_destination_uq').on(
      table.organisationId,
      table.channel,
      table.normalisedDestination
    )
  ]
);
