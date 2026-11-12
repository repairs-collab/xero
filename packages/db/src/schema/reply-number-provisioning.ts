import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { smsNumberPool } from './commerce.js';
import { organisations, users } from './organisation.js';

export const replyNumberProvisioningStatuses = [
  'AWAITING_QUOTE',
  'AWAITING_OWNER_APPROVAL',
  'APPROVED_FOR_MANUAL_ORDER',
  'MANUAL_ORDER_RECORDED',
  'FULFILLED',
  'FAILED',
  'EXPIRED'
] as const;

export type ReplyNumberProvisioningStatus =
  (typeof replyNumberProvisioningStatuses)[number];

export const replyNumberDocumentationStatuses = [
  'UNKNOWN',
  'NOT_REQUIRED',
  'REQUIRED',
  'COMPLETE'
] as const;

export type ReplyNumberDocumentationStatus =
  (typeof replyNumberDocumentationStatuses)[number];

export const replyNumberProvisioningRequests = pgTable(
  'reply_number_provisioning_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    requestKey: varchar('request_key', { length: 200 }).notNull(),
    attempt: integer('attempt').notNull(),
    version: integer('version').notNull().default(1),
    status: varchar('status', { length: 40 })
      .$type<ReplyNumberProvisioningStatus>()
      .notNull()
      .default('AWAITING_QUOTE'),
    quoteSetupFeeMinor: integer('quote_setup_fee_minor'),
    quoteMonthlyFeeMinor: integer('quote_monthly_fee_minor'),
    quoteCurrency: char('quote_currency', { length: 3 }),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),
    quotedAt: timestamp('quoted_at', { withTimezone: true }),
    documentationStatus: varchar('documentation_status', { length: 24 })
      .$type<ReplyNumberDocumentationStatus>()
      .notNull()
      .default('UNKNOWN'),
    documentationEvidenceReference: varchar(
      'documentation_evidence_reference',
      { length: 256 }
    ),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'restrict'
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvalReason: varchar('approval_reason', { length: 500 }),
    externalOrderReference: varchar('external_order_reference', {
      length: 256
    }),
    manualOrderRecordedAt: timestamp('manual_order_recorded_at', {
      withTimezone: true
    }),
    fulfilledNumberId: uuid('fulfilled_number_id'),
    failureCode: varchar('failure_code', { length: 64 }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('reply_number_requests_request_key_uq').on(table.requestKey),
    uniqueIndex('reply_number_requests_org_attempt_uq').on(
      table.organisationId,
      table.attempt
    ),
    uniqueIndex('reply_number_requests_active_org_uq')
      .on(table.organisationId)
      .where(
        sql`${table.status} in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER', 'MANUAL_ORDER_RECORDED')`
      ),
    uniqueIndex('reply_number_requests_fulfilled_number_uq')
      .on(table.fulfilledNumberId)
      .where(sql`${table.fulfilledNumberId} is not null`),
    index('reply_number_requests_org_created_idx').on(
      table.organisationId,
      table.createdAt
    ),
    index('reply_number_requests_status_updated_idx').on(
      table.status,
      table.updatedAt
    ),
    foreignKey({
      columns: [table.fulfilledNumberId],
      foreignColumns: [smsNumberPool.id],
      name: 'reply_number_requests_number_fk'
    }).onDelete('restrict'),
    check(
      'reply_number_requests_provider_ck',
      sql`${table.provider} ~ '^[A-Z][A-Z0-9_-]{1,31}$'`
    ),
    check(
      'reply_number_requests_status_ck',
      sql`${table.status} in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER', 'MANUAL_ORDER_RECORDED', 'FULFILLED', 'FAILED', 'EXPIRED')`
    ),
    check(
      'reply_number_requests_attempt_version_ck',
      sql`${table.attempt} >= 1 and ${table.version} >= 1`
    ),
    check(
      'reply_number_requests_quote_amount_ck',
      sql`(${table.quoteSetupFeeMinor} is null or ${table.quoteSetupFeeMinor} >= 0)
          and (${table.quoteMonthlyFeeMinor} is null or ${table.quoteMonthlyFeeMinor} >= 0)
          and (${table.quoteCurrency} is null or ${table.quoteCurrency} = 'aud')`
    ),
    check(
      'reply_number_requests_quote_bundle_ck',
      sql`(
            ${table.quoteSetupFeeMinor} is null and
            ${table.quoteMonthlyFeeMinor} is null and
            ${table.quoteCurrency} is null and
            ${table.quoteExpiresAt} is null and
            ${table.quotedAt} is null and
            ${table.status} in ('AWAITING_QUOTE', 'FAILED')
          ) or (
            ${table.quoteSetupFeeMinor} is not null and
            ${table.quoteMonthlyFeeMinor} is not null and
            ${table.quoteCurrency} = 'aud' and
            ${table.quoteExpiresAt} is not null and
            ${table.quotedAt} is not null and
            ${table.quoteExpiresAt} > ${table.quotedAt} and
            ${table.status} <> 'AWAITING_QUOTE'
          )`
    ),
    check(
      'reply_number_requests_documentation_ck',
      sql`${table.documentationStatus} in ('UNKNOWN', 'NOT_REQUIRED', 'REQUIRED', 'COMPLETE')
          and (${table.status} in ('AWAITING_QUOTE', 'FAILED') or ${table.documentationStatus} <> 'UNKNOWN')
          and (
            ${table.documentationStatus} <> 'COMPLETE' or
            nullif(btrim(${table.documentationEvidenceReference}), '') is not null
          )
          and (
            ${table.status} not in ('MANUAL_ORDER_RECORDED', 'FULFILLED') or
            ${table.documentationStatus} in ('NOT_REQUIRED', 'COMPLETE')
          )`
    ),
    check(
      'reply_number_requests_approval_ck',
      sql`(
            ${table.approvedByUserId} is null and
            ${table.approvedAt} is null and
            ${table.approvalReason} is null and
            ${table.status} not in ('APPROVED_FOR_MANUAL_ORDER', 'MANUAL_ORDER_RECORDED', 'FULFILLED')
          ) or (
            ${table.approvedByUserId} is not null and
            ${table.approvedAt} is not null and
            nullif(btrim(${table.approvalReason}), '') is not null and
            ${table.status} not in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL')
          )`
    ),
    check(
      'reply_number_requests_external_order_ck',
      sql`(
            ${table.externalOrderReference} is null and
            ${table.manualOrderRecordedAt} is null and
            ${table.status} not in ('MANUAL_ORDER_RECORDED', 'FULFILLED')
          ) or (
            nullif(btrim(${table.externalOrderReference}), '') is not null and
            ${table.manualOrderRecordedAt} is not null and
            ${table.status} not in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER', 'EXPIRED')
          )`
    ),
    check(
      'reply_number_requests_failed_provenance_ck',
      sql`${table.status} <> 'FAILED' or (
            (
              ${table.approvedByUserId} is null or (
                ${table.quoteSetupFeeMinor} is not null and
                ${table.quoteMonthlyFeeMinor} is not null and
                ${table.quoteCurrency} = 'aud' and
                ${table.quoteExpiresAt} is not null and
                ${table.quotedAt} is not null and
                ${table.documentationStatus} <> 'UNKNOWN'
              )
            ) and (
              ${table.externalOrderReference} is null or (
                ${table.approvedByUserId} is not null and
                ${table.documentationStatus} in ('NOT_REQUIRED', 'COMPLETE')
              )
            )
          )`
    ),
    check(
      'reply_number_requests_fulfilment_ck',
      sql`(${table.status} = 'FULFILLED' and ${table.fulfilledNumberId} is not null)
          or (${table.status} <> 'FULFILLED' and ${table.fulfilledNumberId} is null)`
    ),
    check(
      'reply_number_requests_failure_ck',
      sql`(${table.status} = 'FAILED' and nullif(btrim(${table.failureCode}), '') is not null and ${table.failedAt} is not null)
          or (${table.status} <> 'FAILED' and ${table.failureCode} is null and ${table.failedAt} is null)`
    ),
    check(
      'reply_number_requests_expiry_ck',
      sql`(${table.status} = 'EXPIRED' and ${table.expiredAt} is not null)
          or (${table.status} <> 'EXPIRED' and ${table.expiredAt} is null)`
    )
  ]
);

export type ReplyNumberProvisioningRequest =
  typeof replyNumberProvisioningRequests.$inferSelect;
