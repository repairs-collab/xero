import type {
  VoiceCallOperationalState,
  VoiceCallOutcome
} from '@bc5000/domain';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations, users } from './organisation.js';
import { contacts, invoices } from './receivables.js';

export const organisationVoiceSettings = pgTable(
  'organisation_voice_settings',
  {
    organisationId: uuid('organisation_id')
      .primaryKey()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    provider: varchar('provider', { length: 16 })
      .$type<'RETELL'>()
      .notNull()
      .default('RETELL'),
    secretReference: text('secret_reference').notNull(),
    previewPublicKey: text('preview_public_key').notNull(),
    agentId: text('agent_id').notNull(),
    agentVersion: integer('agent_version').notNull(),
    voiceId: text('voice_id').notNull(),
    voiceLabel: text('voice_label').notNull(),
    outboundNumber: text('outbound_number').notNull(),
    transferSipUri: text('transfer_sip_uri'),
    fallbackOfficeNumber: text('fallback_office_number').notNull(),
    officeDestinationLabel: text('office_destination_label').notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    weekdayStartLocal: time('weekday_start_local', {
      precision: 0
    }).notNull(),
    weekdayEndLocal: time('weekday_end_local', { precision: 0 }).notNull(),
    lastConnectionTestedAt: timestamp('last_connection_tested_at', {
      withTimezone: true
    }),
    lastConnectionTestSucceeded: boolean(
      'last_connection_test_succeeded'
    )
      .notNull()
      .default(false),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      'organisation_voice_settings_provider_ck',
      sql`${table.provider} = 'RETELL'`
    ),
    check(
      'organisation_voice_settings_agent_version_ck',
      sql`${table.agentVersion} >= 0`
    ),
    check(
      'organisation_voice_settings_window_ck',
      sql`${table.weekdayStartLocal} < ${table.weekdayEndLocal}`
    )
  ]
);

export const voiceCallRequests = pgTable(
  'voice_call_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    provider: varchar('provider', { length: 16 })
      .$type<'RETELL'>()
      .notNull()
      .default('RETELL'),
    destinationNumber: text('destination_number').notNull(),
    outboundNumber: text('outbound_number').notNull(),
    combinedAmount: numeric('combined_amount', {
      precision: 19,
      scale: 4
    }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    callFlowVersion: integer('call_flow_version'),
    callFlowHash: text('call_flow_hash'),
    approvedFactsHash: text('approved_facts_hash'),
    agentId: text('agent_id').notNull(),
    agentVersion: integer('agent_version').notNull(),
    voiceId: text('voice_id').notNull(),
    voiceSettingsUpdatedAt: timestamp('voice_settings_updated_at', {
      withTimezone: true
    }).notNull(),
    transferTargetLabel: text('transfer_target_label').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    state: varchar('state', { length: 24 })
      .$type<VoiceCallOperationalState>()
      .notNull()
      .default('DRAFT'),
    outcome: varchar('outcome', { length: 32 }).$type<VoiceCallOutcome>(),
    providerCallId: text('provider_call_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    providerAcceptedAt: timestamp('provider_accepted_at', {
      withTimezone: true
    }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureDetail: text('failure_detail'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('voice_call_requests_org_id_uq').on(
      table.organisationId,
      table.id
    ),
    uniqueIndex('voice_call_requests_org_idempotency_uq').on(
      table.organisationId,
      table.idempotencyKey
    ),
    uniqueIndex('voice_call_requests_org_provider_call_uq')
      .on(table.organisationId, table.provider, table.providerCallId)
      .where(sql`${table.providerCallId} is not null`),
    index('voice_call_requests_org_state_idx').on(
      table.organisationId,
      table.state,
      table.createdAt
    ),
    index('voice_call_requests_org_contact_idx').on(
      table.organisationId,
      table.contactId,
      table.createdAt
    ),
    foreignKey({
      name: 'voice_call_requests_org_contact_fk',
      columns: [table.organisationId, table.contactId],
      foreignColumns: [contacts.organisationId, contacts.id]
    }),
    check(
      'voice_call_requests_provider_ck',
      sql`${table.provider} = 'RETELL'`
    ),
    check(
      'voice_call_requests_state_ck',
      sql`${table.state} in ('DRAFT', 'APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED', 'UNKNOWN')`
    ),
    check(
      'voice_call_requests_outcome_ck',
      sql`${table.outcome} is null or ${table.outcome} in ('IDENTITY_CONFIRMED', 'IDENTITY_NOT_CONFIRMED', 'REMINDER_DELIVERED', 'VOICEMAIL_LEFT', 'WRONG_PERSON', 'TRANSFER_REQUESTED', 'TRANSFERRED', 'TRANSFER_UNANSWERED', 'NO_ANSWER', 'BUSY', 'INVALID_DESTINATION', 'PROVIDER_REJECTED')`
    ),
    check(
      'voice_call_requests_approved_facts_ck',
      sql`${table.state} not in ('APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN') or (${table.callFlowVersion} is not null and ${table.callFlowHash} is not null and ${table.approvedFactsHash} is not null and ${table.approvedAt} is not null)`
    ),
    check(
      'voice_call_requests_draft_facts_ck',
      sql`${table.state} <> 'DRAFT' or (${table.callFlowVersion} is null and ${table.callFlowHash} is null and ${table.approvedFactsHash} is null and ${table.approvedAt} is null and ${table.queuedAt} is null)`
    )
  ]
);

export const voiceCallInvoices = pgTable(
  'voice_call_invoices',
  {
    voiceCallId: uuid('voice_call_id')
      .notNull()
      .references(() => voiceCallRequests.id, { onDelete: 'cascade' }),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    xeroInvoiceId: varchar('xero_invoice_id', { length: 64 }).notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    amountDue: numeric('amount_due', {
      precision: 19,
      scale: 4
    }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    dueDate: date('due_date').notNull(),
    syncVersion: integer('sync_version').notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.voiceCallId, table.invoiceId] }),
    index('voice_call_invoices_org_invoice_idx').on(
      table.organisationId,
      table.invoiceId
    ),
    foreignKey({
      name: 'voice_call_invoices_org_call_fk',
      columns: [table.organisationId, table.voiceCallId],
      foreignColumns: [
        voiceCallRequests.organisationId,
        voiceCallRequests.id
      ]
    }).onDelete('cascade'),
    foreignKey({
      name: 'voice_call_invoices_org_invoice_fk',
      columns: [table.organisationId, table.invoiceId],
      foreignColumns: [invoices.organisationId, invoices.id]
    })
  ]
);

export const voiceCallEvents = pgTable(
  'voice_call_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    voiceCallId: uuid('voice_call_id')
      .notNull()
      .references(() => voiceCallRequests.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 })
      .$type<'RETELL'>()
      .notNull()
      .default('RETELL'),
    providerEventKey: text('provider_event_key').notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    safeState: varchar('safe_state', { length: 24 }).$type<
      VoiceCallOperationalState
    >(),
    safeOutcome: varchar('safe_outcome', { length: 32 }).$type<
      VoiceCallOutcome
    >(),
    safeMetadata: jsonb('safe_metadata').$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('voice_call_events_org_provider_event_uq').on(
      table.organisationId,
      table.provider,
      table.providerEventKey
    ),
    index('voice_call_events_call_time_idx').on(
      table.organisationId,
      table.voiceCallId,
      table.occurredAt
    ),
    foreignKey({
      name: 'voice_call_events_org_call_fk',
      columns: [table.organisationId, table.voiceCallId],
      foreignColumns: [
        voiceCallRequests.organisationId,
        voiceCallRequests.id
      ]
    }).onDelete('cascade'),
    check(
      'voice_call_events_provider_ck',
      sql`${table.provider} = 'RETELL'`
    )
  ]
);
