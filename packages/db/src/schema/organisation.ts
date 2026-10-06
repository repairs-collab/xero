import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

export type RolloutScope = 'CONTROLLED' | 'CUSTOMER';

export type OperationalState =
  | 'READY'
  | 'RESET_PREPARING'
  | 'RESET_IN_PROGRESS'
  | 'SYNC_REQUIRED'
  | 'RECONCILIATION_REQUIRED'
  | 'RECONCILED'
  | 'RESET_FAILED';

export const organisations = pgTable(
  'organisations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    xeroOrganisationId: varchar('xero_organisation_id', { length: 64 })
      .notNull()
      .unique(),
    name: text('name').notNull(),
    timeZone: varchar('time_zone', { length: 64 }).notNull(),
    baseCurrency: char('base_currency', { length: 3 }).notNull(),
    sendMode: varchar('send_mode', { length: 16 })
      .$type<'dry-run' | 'live'>()
      .notNull()
      .default('dry-run'),
    rolloutScope: varchar('rollout_scope', { length: 16 })
      .$type<RolloutScope>()
      .notNull()
      .default('CONTROLLED'),
    liveSendAcknowledged: boolean('live_send_acknowledged')
      .notNull()
      .default(false),
    recipientAllowlist: text('recipient_allowlist')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    maintenanceMode: boolean('maintenance_mode').notNull().default(false),
    operationalState: varchar('operational_state', { length: 32 })
      .$type<OperationalState>()
      .notNull()
      .default('READY'),
    operationalStateVersion: integer('operational_state_version')
      .notNull()
      .default(0),
    xeroSyncCursor: text('xero_sync_cursor'),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', {
      withTimezone: true
    }),
    latestReconciledSyncAt: timestamp('latest_reconciled_sync_at', {
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
    check(
      'organisations_rollout_scope_ck',
      sql`${table.rolloutScope} in ('CONTROLLED', 'CUSTOMER')`
    ),
    check(
      'organisations_operational_state_ck',
      sql`${table.operationalState} in ('READY', 'RESET_PREPARING', 'RESET_IN_PROGRESS', 'SYNC_REQUIRED', 'RECONCILIATION_REQUIRED', 'RECONCILED', 'RESET_FAILED')`
    ),
    check(
      'organisations_dry_run_controlled_ck',
      sql`${table.sendMode} <> 'dry-run' or ${table.rolloutScope} = 'CONTROLLED'`
    ),
    check(
      'organisations_operational_state_version_ck',
      sql`${table.operationalStateVersion} >= 0`
    )
  ]
);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  cognitoSubject: varchar('cognito_subject', { length: 128 })
    .notNull()
    .unique(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow()
});

export const memberships = pgTable(
  'memberships',
  {
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 })
      .$type<'ADMIN' | 'OPERATOR'>()
      .notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.organisationId, table.userId] }),
    index('memberships_user_idx').on(table.userId)
  ]
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: varchar('role', { length: 16 })
      .$type<'ADMIN' | 'OPERATOR'>()
      .notNull(),
    status: varchar('status', { length: 16 })
      .$type<'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED'>()
      .notNull()
      .default('PENDING'),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('invitations_org_status_idx').on(
      table.organisationId,
      table.status
    )
  ]
);

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 })
      .$type<'XERO' | 'SINCH' | 'RETELL'>()
      .notNull(),
    secretArn: text('secret_arn').notNull(),
    region: varchar('region', { length: 32 }),
    callbackKeyId: text('callback_key_id'),
    enabled: boolean('enabled').notNull().default(true),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSuccessfulAuthenticationAt: timestamp(
      'last_successful_authentication_at',
      { withTimezone: true }
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('provider_connections_org_provider_uq').on(
      table.organisationId,
      table.provider
    )
  ]
);
