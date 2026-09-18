import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations, users } from './organisation.js';
import { contacts, invoices } from './receivables.js';

export const reminderSequences = pgTable(
  'reminder_sequences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mode: varchar('mode', { length: 16 })
      .$type<'REVIEW' | 'AUTOMATIC'>()
      .notNull()
      .default('REVIEW'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('reminder_sequences_org_name_uq').on(
      table.organisationId,
      table.name
    )
  ]
);

export const reminderSequenceVersions = pgTable(
  'reminder_sequence_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => reminderSequences.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    status: varchar('status', { length: 16 })
      .$type<'DRAFT' | 'ACTIVE' | 'RETIRED'>()
      .notNull(),
    dailyBasis: varchar('daily_basis', { length: 24 })
      .$type<'BUSINESS_DAYS' | 'CALENDAR_DAYS'>()
      .notNull()
      .default('BUSINESS_DAYS'),
    smsAggregation: varchar('sms_aggregation', { length: 32 })
      .$type<'CONSOLIDATED_CUSTOMER' | 'PER_INVOICE'>()
      .notNull()
      .default('CONSOLIDATED_CUSTOMER'),
    sendTime: time('send_time').notNull().default('09:00:00'),
    socialWindowStart: time('social_window_start')
      .notNull()
      .default('08:00:00'),
    socialWindowEnd: time('social_window_end')
      .notNull()
      .default('18:00:00'),
    minimumBalance: numeric('minimum_balance', {
      precision: 19,
      scale: 4
    })
      .notNull()
      .default('0'),
    maxSmsSegments: integer('max_sms_segments').notNull().default(3),
    xeroEmailAfterSmsOptOut: boolean('xero_email_after_sms_opt_out')
      .notNull()
      .default(true),
    configuration: jsonb('configuration')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('sequence_versions_org_sequence_version_uq').on(
      table.organisationId,
      table.sequenceId,
      table.versionNumber
    )
  ]
);

export const sequenceStages = pgTable(
  'sequence_stages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    sequenceVersionId: uuid('sequence_version_id')
      .notNull()
      .references(() => reminderSequenceVersions.id, { onDelete: 'cascade' }),
    stageKey: varchar('stage_key', { length: 64 }).notNull(),
    offsetDays: integer('offset_days').notNull(),
    channel: varchar('channel', { length: 24 })
      .$type<'SMS' | 'XERO_EMAIL' | 'TASK' | 'SMS_DAILY'>()
      .notNull(),
    template: text('template'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('sequence_stages_version_stage_channel_uq').on(
      table.organisationId,
      table.sequenceVersionId,
      table.stageKey,
      table.channel
    )
  ]
);

export const sequenceExclusions = pgTable(
  'sequence_exclusions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    sequenceVersionId: uuid('sequence_version_id')
      .notNull()
      .references(() => reminderSequenceVersions.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('sequence_exclusions_version_kind_value_uq').on(
      table.organisationId,
      table.sequenceVersionId,
      table.kind,
      table.value
    )
  ]
);

export const invoiceChases = pgTable(
  'invoice_chases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => reminderSequences.id),
    customerId: uuid('customer_id').references(() => contacts.id),
    status: varchar('status', { length: 24 })
      .$type<'ACTIVE' | 'PAUSED' | 'CLOSED' | 'COMPLETED'>()
      .notNull(),
    closedReason: text('closed_reason'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('invoice_chases_org_invoice_sequence_uq').on(
      table.organisationId,
      table.invoiceId,
      table.sequenceId
    ),
    index('invoice_chases_customer_status_idx').on(
      table.organisationId,
      table.customerId,
      table.status
    )
  ]
);

export const stageInstances = pgTable(
  'stage_instances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    invoiceChaseId: uuid('invoice_chase_id')
      .notNull()
      .references(() => invoiceChases.id, { onDelete: 'cascade' }),
    sequenceVersionId: uuid('sequence_version_id')
      .notNull()
      .references(() => reminderSequenceVersions.id),
    stageKey: varchar('stage_key', { length: 64 }).notNull(),
    channel: varchar('channel', { length: 24 })
      .$type<'SMS' | 'XERO_EMAIL' | 'TASK'>()
      .notNull(),
    status: varchar('status', { length: 24 })
      .$type<
        | 'SCHEDULED'
        | 'DUE'
        | 'PENDING_APPROVAL'
        | 'QUEUED'
        | 'SUCCEEDED'
        | 'SKIPPED'
        | 'FAILED'
        | 'CANCELLED'
      >()
      .notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sourceVersion: integer('source_version').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('stage_instances_occurrence_uq').on(
      table.organisationId,
      table.invoiceChaseId,
      table.stageKey,
      table.channel,
      table.scheduledAt
    ),
    index('stage_instances_due_idx').on(
      table.organisationId,
      table.status,
      table.scheduledAt
    )
  ]
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    stageInstanceId: uuid('stage_instance_id')
      .notNull()
      .references(() => stageInstances.id, { onDelete: 'cascade' }),
    renderedPreview: text('rendered_preview').notNull(),
    sourceVersion: integer('source_version').notNull(),
    status: varchar('status', { length: 24 })
      .$type<'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'>()
      .notNull(),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('approvals_status_idx').on(
      table.organisationId,
      table.status,
      table.expiresAt
    )
  ]
);
