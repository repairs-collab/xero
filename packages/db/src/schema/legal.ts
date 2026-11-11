import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { users } from './organisation.js';

export const userLegalAcceptances = pgTable(
  'user_legal_acceptances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    termsVersion: varchar('terms_version', { length: 32 }).notNull(),
    privacyVersion: varchar('privacy_version', { length: 32 }).notNull(),
    acceptableUseVersion: varchar('acceptable_use_version', {
      length: 32
    }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('user_legal_acceptances_user_versions_uq').on(
      table.userId,
      table.termsVersion,
      table.privacyVersion,
      table.acceptableUseVersion
    ),
    index('user_legal_acceptances_user_accepted_idx').on(
      table.userId,
      table.acceptedAt
    )
  ]
);
