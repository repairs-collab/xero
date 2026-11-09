import { sql } from 'drizzle-orm';
import {
  check,
  char,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations } from './organisation.js';

export const organisationOnboarding = pgTable(
  'organisation_onboarding',
  {
    organisationId: uuid('organisation_id')
      .primaryKey()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    xeroConnectedAt: timestamp('xero_connected_at', { withTimezone: true }),
    syncReconciledAt: timestamp('sync_reconciled_at', { withTimezone: true }),
    businessDetailsCompletedAt: timestamp('business_details_completed_at', {
      withTimezone: true
    }),
    adminMobile: varchar('admin_mobile', { length: 16 }),
    pendingAdminMobile: varchar('pending_admin_mobile', { length: 16 }),
    adminMobileOtpHash: char('admin_mobile_otp_hash', { length: 64 }),
    adminMobileOtpExpiresAt: timestamp('admin_mobile_otp_expires_at', {
      withTimezone: true
    }),
    adminMobileOtpAttempts: integer('admin_mobile_otp_attempts'),
    adminMobileOtpSentAt: timestamp('admin_mobile_otp_sent_at', {
      withTimezone: true
    }),
    adminMobileVerifiedAt: timestamp('admin_mobile_verified_at', {
      withTimezone: true
    }),
    testSmsCompletedAt: timestamp('test_sms_completed_at', {
      withTimezone: true
    }),
    sequenceReviewedAt: timestamp('sequence_reviewed_at', {
      withTimezone: true
    }),
    subscriptionReadyAt: timestamp('subscription_ready_at', {
      withTimezone: true
    }),
    replyNumberReadyAt: timestamp('reply_number_ready_at', {
      withTimezone: true
    }),
    completedVersion: integer('completed_version'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    check('organisation_onboarding_version_ck', sql`${table.version} >= 1`),
    check(
      'organisation_onboarding_mobile_verification_ck',
      sql`(${table.adminMobile} is null and ${table.adminMobileVerifiedAt} is null) or (${table.adminMobile} ~ '^\\+614[0-9]{8}$' and ${table.adminMobileVerifiedAt} is not null)`
    ),
    check(
      'organisation_onboarding_mobile_otp_ck',
      sql`(${table.pendingAdminMobile} is null and ${table.adminMobileOtpHash} is null and ${table.adminMobileOtpExpiresAt} is null and ${table.adminMobileOtpAttempts} is null and ${table.adminMobileOtpSentAt} is null) or (${table.pendingAdminMobile} ~ '^\\+614[0-9]{8}$' and length(${table.adminMobileOtpHash}) = 64 and ${table.adminMobileOtpExpiresAt} is not null and ${table.adminMobileOtpAttempts} is not null and ${table.adminMobileOtpAttempts} >= 0 and ${table.adminMobileOtpAttempts} <= 5 and ${table.adminMobileOtpSentAt} is not null)`
    ),
    check(
      'organisation_onboarding_completion_ck',
      sql`(${table.completedVersion} is null and ${table.completedAt} is null) or (${table.completedVersion} is not null and ${table.completedAt} is not null and ${table.completedVersion} >= 1 and ${table.completedVersion} <= ${table.version})`
    )
  ]
);
