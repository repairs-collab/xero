import {
  boolean,
  date,
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

import { conversations } from './messaging.js';
import { organisations, users } from './organisation.js';
import { contacts, invoices } from './receivables.js';
import { reminderSequences } from './reminders.js';

export const pauses = pgTable(
  'pauses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    scope: varchar('scope', { length: 16 })
      .$type<'customer' | 'invoice' | 'sequence'>()
      .notNull(),
    contactId: uuid('contact_id').references(() => contacts.id),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    sequenceId: uuid('sequence_id').references(() => reminderSequences.id),
    active: boolean('active').notNull().default(true),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true })
  },
  (table) => [
    index('pauses_active_scope_idx').on(
      table.organisationId,
      table.active,
      table.scope
    )
  ]
);

export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    status: varchar('status', { length: 16 })
      .$type<'OPEN' | 'RESOLVED' | 'CANCELLED'>()
      .notNull(),
    reason: text('reason').notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true })
  },
  (table) => [
    index('disputes_contact_status_idx').on(
      table.organisationId,
      table.contactId,
      table.status
    )
  ]
);

export const paymentPromises = pgTable(
  'payment_promises',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    promisedDate: date('promised_date').notNull(),
    graceDays: integer('grace_days').notNull(),
    status: varchar('status', { length: 16 })
      .$type<'ACTIVE' | 'HONOURED' | 'MISSED' | 'CANCELLED'>()
      .notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true })
  },
  (table) => [
    index('payment_promises_due_idx').on(
      table.organisationId,
      table.status,
      table.promisedDate
    )
  ]
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    contactId: uuid('contact_id').references(() => contacts.id),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    sequenceId: uuid('sequence_id').references(() => reminderSequences.id),
    assignedUserId: uuid('assigned_user_id').references(() => users.id),
    status: varchar('status', { length: 16 })
      .$type<'OPEN' | 'COMPLETED' | 'CANCELLED'>()
      .notNull()
      .default('OPEN'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    summary: text('summary').notNull(),
    resolutionNote: text('resolution_note'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('tasks_open_idx').on(
      table.organisationId,
      table.status,
      table.dueAt
    )
  ]
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 })
      .$type<'XERO' | 'SINCH'>()
      .notNull(),
    providerEventKey: text('provider_event_key').notNull(),
    providerEventId: text('provider_event_id'),
    bodyHash: text('body_hash').notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    providerPayload: jsonb('provider_payload')
      .$type<Record<string, unknown>>()
      .notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingAttempts: integer('processing_attempts').notNull().default(0),
    processingError: text('processing_error')
  },
  (table) => [
    uniqueIndex('webhook_events_org_provider_event_uq').on(
      table.organisationId,
      table.provider,
      table.providerEventKey
    ),
    index('webhook_events_unprocessed_idx').on(
      table.organisationId,
      table.processedAt,
      table.receivedAt
    )
  ]
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: text('entity_id').notNull(),
    correlationId: text('correlation_id'),
    beforeValue: jsonb('before_value').$type<Record<string, unknown>>(),
    afterValue: jsonb('after_value').$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('audit_events_entity_idx').on(
      table.organisationId,
      table.entityType,
      table.entityId,
      table.occurredAt
    ),
    index('audit_events_correlation_idx').on(
      table.organisationId,
      table.correlationId
    )
  ]
);

export const conversationAssignments = pgTable(
  'conversation_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    assignedUserId: uuid('assigned_user_id').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('conversation_assignments_conversation_idx').on(
      table.organisationId,
      table.conversationId,
      table.assignedAt
    )
  ]
);
