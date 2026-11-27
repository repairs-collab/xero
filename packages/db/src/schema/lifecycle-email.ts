import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organisations } from './organisation.js';

export const lifecycleEmailTemplates = [
  'WORKSPACE_WELCOME', 'ONBOARDING_COMPLETED', 'PAYMENT_CONFIRMED',
  'SMS_USAGE_WARNING', 'PAYMENT_FAILED', 'PAYMENT_RECOVERED',
  'CANCELLATION_SCHEDULED', 'CANCELLATION_EFFECTIVE',
  'EXPORT_DELIVERED', 'PRIVACY_REQUEST_RECEIVED'
] as const;
export type LifecycleEmailTemplate = (typeof lifecycleEmailTemplates)[number];

export const lifecycleEmailStatuses = ['PENDING', 'SENDING', 'RETRY', 'SENT', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const;
export type LifecycleEmailStatus = (typeof lifecycleEmailStatuses)[number];
export type LifecycleEmailRenderData = Record<string, string | number | boolean | null>;

export const lifecycleEmailOutbox = pgTable('lifecycle_email_outbox', {
  id: uuid('id').defaultRandom().primaryKey(),
  organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  recipient: varchar('recipient', { length: 320 }).notNull(),
  template: varchar('template', { length: 32 }).$type<LifecycleEmailTemplate>().notNull(),
  templateVersion: integer('template_version').notNull().default(1),
  renderData: jsonb('render_data').$type<LifecycleEmailRenderData>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  sourceType: varchar('source_type', { length: 64 }).notNull(),
  sourceId: text('source_id').notNull(),
  status: varchar('status', { length: 16 }).$type<LifecycleEmailStatus>().notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  claimToken: uuid('claim_token'),
  cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
  messageId: varchar('message_id', { length: 512 }),
  providerMessageId: varchar('provider_message_id', { length: 512 }),
  lastFailureCode: varchar('last_failure_code', { length: 64 }),
  lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('lifecycle_email_org_idempotency_uq').on(t.organisationId, t.idempotencyKey),
  index('lifecycle_email_pending_idx').on(t.availableAt, t.id).where(sql`${t.status} = 'PENDING'`),
  index('lifecycle_email_retry_idx').on(t.nextAttemptAt, t.id).where(sql`${t.status} = 'RETRY'`),
  index('lifecycle_email_expiry_idx').on(t.expiresAt).where(sql`${t.status} in ('PENDING', 'RETRY')`),
  index('lifecycle_email_sending_idx').on(t.lastAttemptedAt).where(sql`${t.status} = 'SENDING'`),
  index('lifecycle_email_source_idx').on(t.organisationId, t.sourceType, t.sourceId, t.template),
  index('lifecycle_email_org_status_created_idx').on(t.organisationId, t.status, t.createdAt),
  index('lifecycle_email_updated_idx').on(t.updatedAt.desc(), t.id.desc()),
  index('lifecycle_email_status_updated_idx').on(t.status, t.updatedAt.desc()),
  check('lifecycle_email_status_ck', sql`${t.status} in ('PENDING','SENDING','RETRY','SENT','FAILED','UNKNOWN','CANCELLED')`),
  check('lifecycle_email_template_ck', sql`${t.template} in ('WORKSPACE_WELCOME','ONBOARDING_COMPLETED','PAYMENT_CONFIRMED','SMS_USAGE_WARNING','PAYMENT_FAILED','PAYMENT_RECOVERED','CANCELLATION_SCHEDULED','CANCELLATION_EFFECTIVE','EXPORT_DELIVERED','PRIVACY_REQUEST_RECEIVED')`),
  check('lifecycle_email_render_ck', sql`jsonb_typeof(${t.renderData}) = 'object' and not jsonb_path_exists(${t.renderData}, 'strict $.* ? (@.type() == "array" || @.type() == "object")')`),
  check('lifecycle_email_identity_ck', sql`btrim(${t.idempotencyKey}) <> '' and btrim(${t.sourceType}) <> '' and btrim(${t.sourceId}) <> '' and ${t.templateVersion} > 0`),
  check('lifecycle_email_recipient_ck', sql`${t.recipient} = lower(btrim(${t.recipient})) and ${t.recipient} ~ '^[^[:space:][:cntrl:]@,;:<>"]+@[^[:space:][:cntrl:]@,;:<>"]+[.][^[:space:][:cntrl:]@,;:<>"]+$'`),
  check('lifecycle_email_expiry_ck', sql`${t.expiresAt} > ${t.availableAt}`),
  check('lifecycle_email_attempt_ck', sql`${t.attempts} >= 0 and (${t.attempts} = 0) = (${t.lastAttemptedAt} is null) and (${t.status} not in ('SENDING','RETRY','SENT','FAILED','UNKNOWN') or ${t.attempts} > 0)`),
  check('lifecycle_email_claim_ck', sql`(${t.status} = 'SENDING') = (${t.claimToken} is not null)`),
  check('lifecycle_email_retry_ck', sql`(${t.status} = 'RETRY') = (${t.nextAttemptAt} is not null) and (${t.nextAttemptAt} is null or (${t.nextAttemptAt} > ${t.lastAttemptedAt} and ${t.nextAttemptAt} < ${t.expiresAt}))`),
  check('lifecycle_email_sent_ck', sql`
    (${t.status} <> 'SENT' and ${t.sentAt} is null and ${t.messageId} is null and ${t.providerMessageId} is null)
    or (${t.status} = 'SENT' and ${t.sentAt} is not null and ${t.messageId} is not null
        and ${t.messageId} collate "C" ~ '^<[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*>$'
        and (${t.providerMessageId} is null or (${t.providerMessageId} ~ '[^[:space:]]' and ${t.providerMessageId} !~ '[[:cntrl:]]')))`),
  check('lifecycle_email_cancellation_ck', sql`${t.cancellationRequestedAt} is null or ${t.status} in ('SENDING','CANCELLED','SENT','UNKNOWN')`),
  check('lifecycle_email_failure_code_ck', sql`${t.lastFailureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`)
]);
