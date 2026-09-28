import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations, users } from './organisation.js';
import { contacts, invoices } from './receivables.js';

export type ReminderWhitelistScope = 'CLIENT' | 'INVOICE';

export const reminderWhitelistEntries = pgTable(
  'reminder_whitelist_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    scope: varchar('scope', { length: 16 })
      .$type<ReminderWhitelistScope>()
      .notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    reason: text('reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedByUserId: uuid('removed_by_user_id').references(() => users.id),
    removedAt: timestamp('removed_at', { withTimezone: true })
  },
  (table) => [
    check(
      'reminder_whitelist_target_shape_ck',
      sql`(${table.scope} = 'CLIENT' and ${table.invoiceId} is null) or (${table.scope} = 'INVOICE' and ${table.invoiceId} is not null)`
    ),
    uniqueIndex('reminder_whitelist_active_client_uq')
      .on(table.organisationId, table.contactId)
      .where(sql`${table.scope} = 'CLIENT' and ${table.removedAt} is null`),
    uniqueIndex('reminder_whitelist_active_invoice_uq')
      .on(table.organisationId, table.invoiceId)
      .where(sql`${table.scope} = 'INVOICE' and ${table.removedAt} is null`),
    index('reminder_whitelist_active_lookup_idx').on(
      table.organisationId,
      table.contactId,
      table.invoiceId,
      table.removedAt
    )
  ]
);
