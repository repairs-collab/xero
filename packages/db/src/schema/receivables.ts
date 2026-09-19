import {
  boolean,
  char,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations } from './organisation.js';

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    xeroContactId: varchar('xero_contact_id', { length: 64 }).notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    email: text('email'),
    sourceVersion: integer('source_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('contacts_org_xero_contact_uq').on(
      table.organisationId,
      table.xeroContactId
    ),
    index('contacts_org_active_idx').on(table.organisationId, table.active)
  ]
);

export const contactChannels = pgTable(
  'contact_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 })
      .$type<'SMS' | 'EMAIL'>()
      .notNull(),
    sourceValue: text('source_value').notNull(),
    normalisedValue: text('normalised_value').notNull(),
    usable: boolean('usable').notNull().default(true),
    approvedOverride: boolean('approved_override').notNull().default(false),
    overrideReason: text('override_reason'),
    approvedByUserId: uuid('approved_by_user_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('contact_channels_org_contact_kind_value_uq').on(
      table.organisationId,
      table.contactId,
      table.kind,
      table.normalisedValue
    )
  ]
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    xeroInvoiceId: varchar('xero_invoice_id', { length: 64 }).notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    invoiceNumber: text('invoice_number').notNull(),
    type: varchar('type', { length: 16 })
      .$type<'ACCREC' | 'ACCPAY'>()
      .notNull(),
    status: varchar('status', { length: 16 })
      .$type<
        | 'DRAFT'
        | 'SUBMITTED'
        | 'AUTHORISED'
        | 'PAID'
        | 'VOIDED'
        | 'DELETED'
      >()
      .notNull(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),
    amountDue: numeric('amount_due', {
      precision: 19,
      scale: 4
    }).notNull(),
    total: numeric('total', { precision: 19, scale: 4 }),
    currency: char('currency', { length: 3 }).notNull(),
    onlineInvoiceUrl: text('online_invoice_url'),
    syncVersion: integer('sync_version').notNull(),
    xeroUpdatedAt: timestamp('xero_updated_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('invoices_org_xero_invoice_uq').on(
      table.organisationId,
      table.xeroInvoiceId
    ),
    index('invoices_eligibility_idx').on(
      table.organisationId,
      table.status,
      table.amountDue,
      table.dueDate
    ),
    index('invoices_contact_idx').on(
      table.organisationId,
      table.contactId
    )
  ]
);
