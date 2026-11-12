import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations } from './organisation.js';
import { contacts } from './receivables.js';

export type DebtContactChannel = 'SMS' | 'VOICE';

export const debtContactClaims = pgTable(
  'debt_contact_claims',
  {
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull(),
    localDate: date('local_date').notNull(),
    channel: varchar('channel', { length: 16 })
      .$type<DebtContactChannel>()
      .notNull(),
    sourceId: uuid('source_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: 'debt_contact_claims_pk',
      columns: [table.organisationId, table.contactId, table.localDate]
    }),
    foreignKey({
      name: 'debt_contact_claims_org_contact_fk',
      columns: [table.organisationId, table.contactId],
      foreignColumns: [contacts.organisationId, contacts.id]
    }).onDelete('cascade'),
    check(
      'debt_contact_claims_channel_ck',
      sql`${table.channel} in ('SMS', 'VOICE')`
    )
  ]
);
