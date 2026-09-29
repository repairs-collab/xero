import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

export type OperationalResetStatus =
  | 'PREPARING'
  | 'SNAPSHOT_CREATED'
  | 'RESETTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED';

export const operationalResetRuns = pgTable(
  'operational_reset_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 24 })
      .$type<OperationalResetStatus>()
      .notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    deployedCommit: varchar('deployed_commit', { length: 64 }).notNull(),
    snapshotIdentifier: text('snapshot_identifier'),
    rowCountManifest: jsonb('row_count_manifest')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    jobPurgeManifest: jsonb('job_purge_manifest')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    failureCode: text('failure_code'),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    snapshotCreatedAt: timestamp('snapshot_created_at', {
      withTimezone: true
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check(
      'operational_reset_runs_status_ck',
      sql`${table.status} in ('PREPARING', 'SNAPSHOT_CREATED', 'RESETTING', 'COMPLETED', 'FAILED', 'ABORTED')`
    ),
    uniqueIndex('operational_reset_runs_one_active_uq')
      .on(table.organisationId)
      .where(
        sql`${table.status} in ('PREPARING', 'SNAPSHOT_CREATED', 'RESETTING', 'FAILED')`
      ),
    index('operational_reset_runs_org_requested_idx').on(
      table.organisationId,
      table.requestedAt
    )
  ]
);

export const rolloutReconciliations = pgTable(
  'rollout_reconciliations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    syncCompletedAt: timestamp('sync_completed_at', {
      withTimezone: true
    }).notNull(),
    activeContactCount: integer('active_contact_count').notNull(),
    outstandingInvoiceCount: integer('outstanding_invoice_count').notNull(),
    outstandingTotals: jsonb('outstanding_totals')
      .$type<Record<string, string>>()
      .notNull(),
    generatedApprovalCount: integer('generated_approval_count').notNull(),
    enabledSequenceCount: integer('enabled_sequence_count').notNull(),
    allEnabledSequencesReview: boolean('all_enabled_sequences_review')
      .notNull(),
    acknowledgedByUserId: uuid('acknowledged_by_user_id')
      .notNull()
      .references(() => users.id),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('rollout_reconciliations_org_sync_uq').on(
      table.organisationId,
      table.syncCompletedAt
    ),
    check(
      'rollout_reconciliations_nonnegative_counts_ck',
      sql`${table.activeContactCount} >= 0 and ${table.outstandingInvoiceCount} >= 0 and ${table.generatedApprovalCount} >= 0 and ${table.enabledSequenceCount} >= 0`
    )
  ]
);
