import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations } from './organisation.js';
import { outboundMessages } from './messaging.js';

export const soloAu2000PlanCode = 'SOLO_AU_2000' as const;
export type SubscriptionPlanCode = typeof soloAu2000PlanCode;
export type SubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCEL_AT_PERIOD_END'
  | 'CANCELLED'
  | 'INCOMPLETE';

export const subscriptions = pgTable(
  'subscriptions',
  {
    organisationId: uuid('organisation_id')
      .primaryKey()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    planCode: varchar('plan_code', { length: 32 })
      .$type<SubscriptionPlanCode>()
      .notNull(),
    status: varchar('status', { length: 32 })
      .$type<SubscriptionStatus>()
      .notNull(),
    stripeProviderStatus: varchar('stripe_provider_status', { length: 32 }),
    trustedStripeProviderStatus: varchar('trusted_stripe_provider_status', { length: 32 }),
    stripeCustomerId: varchar('stripe_customer_id', { length: 128 }),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 128 }),
    currentPeriodStart: timestamp('current_period_start', {
      withTimezone: true
    }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    lastStripeEventCreatedAt: timestamp('last_stripe_event_created_at', {
      withTimezone: true
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('subscriptions_stripe_customer_uq').on(table.stripeCustomerId),
    uniqueIndex('subscriptions_stripe_subscription_uq').on(
      table.stripeSubscriptionId
    ),
    index('subscriptions_status_idx').on(table.status),
    check(
      'subscriptions_plan_code_ck',
      sql`${table.planCode} = 'SOLO_AU_2000'`
    ),
    check(
      'subscriptions_status_ck',
      sql`${table.status} in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END', 'CANCELLED', 'INCOMPLETE')`
    ),
    check(
      'subscriptions_period_ck',
      sql`(${table.currentPeriodStart} is null and ${table.currentPeriodEnd} is null) or (${table.currentPeriodStart} is not null and ${table.currentPeriodEnd} is not null and ${table.currentPeriodEnd} > ${table.currentPeriodStart})`
    )
  ]
);

export const retiredStripeSubscriptions = pgTable('retired_stripe_subscriptions', {
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 128 }).primaryKey(),
  organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' })
});

export type SubscriptionEventOutcome =
  | 'APPLIED'
  | 'IGNORED_OUT_OF_ORDER'
  | 'REJECTED';

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    stripeEventId: varchar('stripe_event_id', { length: 128 }).notNull(),
    eventType: text('event_type').notNull(),
    stripeEventCreatedAt: timestamp('stripe_event_created_at', {
      withTimezone: true
    }).notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    providerObjectType: varchar('provider_object_type', { length: 16 })
      .$type<BillingProviderObjectType>(),
    providerObjectId: varchar('provider_object_id', { length: 128 }),
    billingCaseKind: varchar('billing_case_kind', { length: 32 })
      .$type<BillingCaseKind>(),
    billingCaseStatus: varchar('billing_case_status', { length: 32 })
      .$type<BillingCaseStatus>(),
    blocksSending: boolean('blocks_sending'),
    amountMinor: integer('amount_minor'),
    heldTemplate: varchar('held_template', { length: 32 })
      .$type<TransactionalEmailTemplate>(),
    outcome: varchar('outcome', { length: 32 })
      .$type<SubscriptionEventOutcome>()
      .notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('subscription_events_stripe_event_uq').on(table.stripeEventId),
    index('subscription_events_org_created_idx').on(
      table.organisationId,
      table.stripeEventCreatedAt
    ),
    index('subscription_events_operational_order_idx').on(
      table.organisationId,
      table.providerObjectType,
      table.providerObjectId,
      table.stripeEventCreatedAt
    ),
    check(
      'subscription_events_outcome_ck',
      sql`${table.outcome} in ('APPLIED', 'IGNORED_OUT_OF_ORDER', 'REJECTED')`
    ),
    check(
      'subscription_events_payload_hash_ck',
      sql`length(${table.payloadHash}) = 64`
    ),
    check(
      'subscription_events_operational_amount_ck',
      sql`${table.amountMinor} is null or ${table.amountMinor} >= 0`
    ),
    check(
      'subscription_events_operational_metadata_ck',
      sql`(
        ${table.providerObjectType} is null and
        ${table.providerObjectId} is null and
        ${table.billingCaseKind} is null and
        ${table.billingCaseStatus} is null and
        ${table.blocksSending} is null and
        ${table.amountMinor} is null and
        ${table.heldTemplate} is null
      ) or (
        ${table.providerObjectType} is not null and
        ${table.providerObjectId} is not null and
        ${table.billingCaseKind} is not null and
        ${table.billingCaseStatus} is not null and
        ${table.blocksSending} is not null and
        ${table.amountMinor} is not null and
        ${table.heldTemplate} is not null
      )`
    )
  ]
);

export type BillingCaseKind = 'PAYMENT_FAILURE' | 'REFUND' | 'DISPUTE';
export type BillingCaseStatus = 'OPEN' | 'RESOLVED' | 'REVIEW_REQUIRED';
export type BillingProviderObjectType = 'INVOICE' | 'CHARGE' | 'DISPUTE';
export type BillingSubscriptionRelation = 'CURRENT' | 'RETIRED';

export const billingCases = pgTable(
  'billing_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).$type<BillingCaseKind>().notNull(),
    status: varchar('status', { length: 32 })
      .$type<BillingCaseStatus>()
      .notNull(),
    providerObjectType: varchar('provider_object_type', { length: 16 })
      .$type<BillingProviderObjectType>()
      .notNull(),
    providerObjectId: varchar('provider_object_id', { length: 128 }).notNull(),
    providerStatus: varchar('provider_status', { length: 64 }).notNull(),
    stripeSubscriptionId: varchar('stripe_subscription_id', {
      length: 128
    }).notNull(),
    subscriptionRelation: varchar('subscription_relation', { length: 16 })
      .$type<BillingSubscriptionRelation>()
      .notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    blocksSending: boolean('blocks_sending').notNull().default(false),
    latestProviderEventId: varchar('latest_provider_event_id', {
      length: 128
    }).notNull(),
    latestProviderEventCreatedAt: timestamp(
      'latest_provider_event_created_at',
      { withTimezone: true }
    ).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    unique('billing_cases_org_id_uq').on(table.organisationId, table.id),
    uniqueIndex('billing_cases_org_kind_provider_uq').on(
      table.organisationId,
      table.kind,
      table.providerObjectType,
      table.providerObjectId
    ),
    index('billing_cases_org_status_created_idx').on(
      table.organisationId,
      table.status,
      table.createdAt
    ),
    index('billing_cases_blocking_status_idx').on(
      table.blocksSending,
      table.status,
      table.createdAt
    ),
    check(
      'billing_cases_kind_ck',
      sql`${table.kind} in ('PAYMENT_FAILURE', 'REFUND', 'DISPUTE')`
    ),
    check(
      'billing_cases_status_ck',
      sql`${table.status} in ('OPEN', 'RESOLVED', 'REVIEW_REQUIRED')`
    ),
    check(
      'billing_cases_provider_object_type_ck',
      sql`${table.providerObjectType} in ('INVOICE', 'CHARGE', 'DISPUTE')`
    ),
    check(
      'billing_cases_subscription_relation_ck',
      sql`${table.subscriptionRelation} in ('CURRENT', 'RETIRED')`
    ),
    check('billing_cases_amount_ck', sql`${table.amountMinor} >= 0`),
    check('billing_cases_currency_ck', sql`${table.currency} = 'aud'`),
    check(
      'billing_cases_resolution_ck',
      sql`(${table.status} = 'RESOLVED' and ${table.resolvedAt} is not null) or (${table.status} <> 'RESOLVED' and ${table.resolvedAt} is null)`
    )
  ]
);

export type TransactionalEmailTemplate =
  | 'PAYMENT_FAILED'
  | 'PAYMENT_RECOVERED'
  | 'REFUND_RECORDED'
  | 'DISPUTE_OPENED'
  | 'DISPUTE_CLOSED';
export type TransactionalEmailStatus =
  | 'HELD'
  | 'PENDING'
  | 'SENT'
  | 'FAILED';
export type TransactionalEmailRenderData = Record<
  string,
  string | number | boolean | null
>;

export const transactionalEmailOutbox = pgTable(
  'transactional_email_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    billingCaseId: uuid('billing_case_id').notNull(),
    recipient: varchar('recipient', { length: 320 }).notNull(),
    template: varchar('template', { length: 32 })
      .$type<TransactionalEmailTemplate>()
      .notNull(),
    templateVersion: integer('template_version').notNull().default(1),
    renderData: jsonb('render_data')
      .$type<TransactionalEmailRenderData>()
      .notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    sourceEventId: varchar('source_event_id', { length: 128 }),
    status: varchar('status', { length: 16 })
      .$type<TransactionalEmailStatus>()
      .notNull()
      .default('HELD'),
    attempts: integer('attempts').notNull().default(0),
    lastFailureCode: varchar('last_failure_code', { length: 64 }),
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('transactional_email_outbox_org_idempotency_uq').on(
      table.organisationId,
      table.idempotencyKey
    ),
    index('transactional_email_outbox_org_status_created_idx').on(
      table.organisationId,
      table.status,
      table.createdAt
    ),
    index('transactional_email_outbox_case_created_idx').on(
      table.billingCaseId,
      table.createdAt
    ),
    index('transactional_email_outbox_case_source_idx').on(
      table.billingCaseId,
      table.sourceEventId
    ),
    foreignKey({
      name: 'transactional_email_outbox_org_case_fk',
      columns: [table.organisationId, table.billingCaseId],
      foreignColumns: [billingCases.organisationId, billingCases.id]
    }).onDelete('restrict'),
    check(
      'transactional_email_outbox_template_ck',
      sql`${table.template} in ('PAYMENT_FAILED', 'PAYMENT_RECOVERED', 'REFUND_RECORDED', 'DISPUTE_OPENED', 'DISPUTE_CLOSED')`
    ),
    check(
      'transactional_email_outbox_status_ck',
      sql`${table.status} in ('HELD', 'PENDING', 'SENT', 'FAILED')`
    ),
    check(
      'transactional_email_outbox_template_version_ck',
      sql`${table.templateVersion} >= 1`
    ),
    check(
      'transactional_email_outbox_attempts_ck',
      sql`${table.attempts} >= 0`
    ),
    check(
      'transactional_email_outbox_render_data_ck',
      sql`jsonb_typeof(${table.renderData}) = 'object'`
    ),
    check(
      'transactional_email_outbox_sent_ck',
      sql`(${table.status} = 'SENT' and ${table.sentAt} is not null) or (${table.status} <> 'SENT' and ${table.sentAt} is null)`
    )
  ]
);

export type RetentionCaseSource =
  | 'TRIAL_EXPIRED'
  | 'SUBSCRIPTION_CANCELLED'
  | 'CUSTOMER_REQUEST';
export type RetentionCaseStatus =
  | 'SCHEDULED'
  | 'REVIEW_REQUIRED'
  | 'LEGAL_HOLD'
  | 'COMPLETED';

/**
 * A retention case records the promised 30-day account review deadline. It is
 * intentionally not a cascade-delete queue: reaching the deadline transitions
 * the case to REVIEW_REQUIRED so unresolved invoices, protected records and
 * backup expiry can be reviewed before any destructive operation is approved.
 */
export const retentionCases = pgTable(
  'retention_cases',
  {
    organisationId: uuid('organisation_id')
      .primaryKey()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 32 })
      .$type<RetentionCaseSource>()
      .notNull(),
    status: varchar('status', { length: 32 })
      .$type<RetentionCaseStatus>()
      .notNull()
      .default('SCHEDULED'),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true })
      .notNull(),
    reviewAfter: timestamp('review_after', { withTimezone: true }).notNull(),
    reviewAttempts: integer('review_attempts').notNull().default(0),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
    lastReviewError: text('last_review_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('retention_cases_due_idx').on(table.status, table.reviewAfter),
    check(
      'retention_cases_source_ck',
      sql`${table.source} in ('TRIAL_EXPIRED', 'SUBSCRIPTION_CANCELLED', 'CUSTOMER_REQUEST')`
    ),
    check(
      'retention_cases_status_ck',
      sql`${table.status} in ('SCHEDULED', 'REVIEW_REQUIRED', 'LEGAL_HOLD', 'COMPLETED')`
    ),
    check(
      'retention_cases_review_after_ck',
      sql`${table.reviewAfter} > ${table.disconnectedAt}`
    ),
    check(
      'retention_cases_attempts_ck',
      sql`${table.reviewAttempts} >= 0`
    )
  ]
);

export type SmsNumberStatus =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'READY'
  | 'QUARANTINED'
  | 'RELEASED';

export const smsNumberPool = pgTable(
  'sms_number_pool',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    e164Number: varchar('e164_number', { length: 16 }).notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerNumberId: varchar('provider_number_id', { length: 128 }),
    providerVerifiedAt: timestamp('provider_verified_at', {
      withTimezone: true
    }),
    status: varchar('status', { length: 24 })
      .$type<SmsNumberStatus>()
      .notNull()
      .default('AVAILABLE'),
    organisationId: uuid('organisation_id').references(() => organisations.id, {
      onDelete: 'restrict'
    }),
    reservedAt: timestamp('reserved_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    quarantineUntil: timestamp('quarantine_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    unique('sms_number_pool_org_id_uq').on(table.organisationId, table.id),
    uniqueIndex('sms_number_pool_e164_uq').on(table.e164Number),
    uniqueIndex('sms_number_pool_provider_number_uq').on(
      table.provider,
      table.providerNumberId
    ),
    uniqueIndex('sms_number_pool_active_org_uq')
      .on(table.organisationId)
      .where(
        sql`${table.organisationId} is not null and ${table.status} in ('RESERVED', 'READY', 'QUARANTINED')`
      ),
    index('sms_number_pool_available_idx').on(table.status, table.createdAt),
    check(
      'sms_number_pool_number_ck',
      sql`${table.e164Number} ~ '^[+]61[0-9]{9}$'`
    ),
    check(
      'sms_number_pool_status_ck',
      sql`${table.status} in ('AVAILABLE', 'RESERVED', 'READY', 'QUARANTINED', 'RELEASED')`
    ),
    check(
      'sms_number_pool_provider_verification_ck',
      sql`${table.providerVerifiedAt} is null or ${table.providerNumberId} is not null`
    ),
    check(
      'sms_number_pool_assignment_ck',
      sql`(${table.status} in ('AVAILABLE', 'RELEASED') and ${table.organisationId} is null) or (${table.status} in ('RESERVED', 'READY', 'QUARANTINED') and ${table.organisationId} is not null)`
    )
  ]
);

export const smsAllowanceSettings = pgTable(
  'sms_allowance_settings',
  {
    organisationId: uuid('organisation_id')
      .primaryKey()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    includedParts: integer('included_parts').notNull().default(2_000),
    warningPercent: integer('warning_percent').notNull().default(80),
    overageEnabled: boolean('overage_enabled').notNull().default(false),
    overageCapCents: integer('overage_cap_cents'),
    overageCentsPerPart: integer('overage_cents_per_part'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check('sms_allowance_included_ck', sql`${table.includedParts} >= 1`),
    check(
      'sms_allowance_warning_ck',
      sql`${table.warningPercent} between 1 and 100`
    ),
    check(
      'sms_allowance_cap_ck',
      sql`${table.overageCapCents} is null or ${table.overageCapCents} >= 0`
    ),
    check(
      'sms_allowance_rate_ck',
      sql`${table.overageCentsPerPart} is null or ${table.overageCentsPerPart} >= 1`
    )
  ]
);

export type SmsUsageLedgerEntryType =
  | 'RESERVE'
  | 'COMMIT'
  | 'RELEASE'
  | 'ADJUST';

export const smsUsageLedger = pgTable(
  'sms_usage_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    billingPeriodStart: timestamp('billing_period_start', {
      withTimezone: true
    }).notNull(),
    billingPeriodEnd: timestamp('billing_period_end', {
      withTimezone: true
    }).notNull(),
    outboundMessageId: uuid('outbound_message_id').references(
      () => outboundMessages.id,
      { onDelete: 'restrict' }
    ),
    source: varchar('source', { length: 32 }).notNull(),
    entryType: varchar('entry_type', { length: 16 })
      .$type<SmsUsageLedgerEntryType>()
      .notNull(),
    partDelta: integer('part_delta').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('sms_usage_ledger_org_idempotency_uq').on(
      table.organisationId,
      table.idempotencyKey
    ),
    index('sms_usage_ledger_period_idx').on(
      table.organisationId,
      table.billingPeriodStart,
      table.billingPeriodEnd,
      table.occurredAt
    ),
    index('sms_usage_ledger_outbound_idx').on(
      table.organisationId,
      table.outboundMessageId,
      table.occurredAt
    ),
    check(
      'sms_usage_ledger_entry_type_ck',
      sql`${table.entryType} in ('RESERVE', 'COMMIT', 'RELEASE', 'ADJUST')`
    ),
    check(
      'sms_usage_ledger_delta_ck',
      sql`(${table.entryType} in ('RESERVE', 'COMMIT') and ${table.partDelta} > 0) or (${table.entryType} = 'RELEASE' and ${table.partDelta} < 0) or (${table.entryType} = 'ADJUST' and ${table.partDelta} <> 0)`
    ),
    check(
      'sms_usage_ledger_period_ck',
      sql`${table.billingPeriodEnd} > ${table.billingPeriodStart}`
    )
  ]
);
