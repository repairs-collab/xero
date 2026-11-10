import { sql } from 'drizzle-orm';
import {
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

export type XeroOAuthFlowPurpose = 'NEW_SOLO' | 'CONNECT_EXISTING';
export type XeroConnectionStatus = 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECTED';

export interface EncryptedRefreshTokenEnvelope {
  version: number;
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface XeroTenantCandidate {
  connectionId: string;
  tenantId: string;
  tenantName: string;
  tenantType?: string;
  xeroOrganisationId?: string;
  organisationName?: string;
  baseCurrency?: string;
  timeZone?: string;
}

export const xeroOAuthTransactions = pgTable(
  'xero_oauth_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    stateHash: varchar('state_hash', { length: 64 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    existingOrganisationId: uuid('existing_organisation_id').references(
      () => organisations.id,
      { onDelete: 'cascade' }
    ),
    flowPurpose: varchar('flow_purpose', { length: 24 })
      .$type<XeroOAuthFlowPurpose>()
      .notNull(),
    returnPath: text('return_path').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('xero_oauth_transactions_state_hash_uq').on(table.stateHash),
    index('xero_oauth_transactions_user_expiry_idx').on(table.userId, table.expiresAt),
    check(
      'xero_oauth_transactions_flow_purpose_ck',
      sql`${table.flowPurpose} in ('NEW_SOLO', 'CONNECT_EXISTING')`
    ),
    check(
      'xero_oauth_transactions_binding_ck',
      sql`(${table.flowPurpose} = 'NEW_SOLO' and ${table.existingOrganisationId} is null) or (${table.flowPurpose} = 'CONNECT_EXISTING' and ${table.existingOrganisationId} is not null)`
    ),
    check(
      'xero_oauth_transactions_state_hash_ck',
      sql`length(${table.stateHash}) = 64`
    ),
    check(
      'xero_oauth_transactions_return_path_ck',
      sql`${table.returnPath} like '/%' and ${table.returnPath} not like '//%'`
    )
  ]
);

export const xeroPendingAuthorisations = pgTable(
  'xero_pending_authorisations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    existingOrganisationId: uuid('existing_organisation_id').references(
      () => organisations.id,
      { onDelete: 'cascade' }
    ),
    flowPurpose: varchar('flow_purpose', { length: 24 })
      .$type<XeroOAuthFlowPurpose>()
      .notNull(),
    encryptedRefreshToken: jsonb('encrypted_refresh_token')
      .$type<EncryptedRefreshTokenEnvelope>()
      .notNull(),
    candidateTenants: jsonb('candidate_tenants')
      .$type<XeroTenantCandidate[]>()
      .notNull(),
    grantedScopes: text('granted_scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('xero_pending_authorisations_user_expiry_idx').on(table.userId, table.expiresAt),
    check(
      'xero_pending_authorisations_flow_purpose_ck',
      sql`${table.flowPurpose} in ('NEW_SOLO', 'CONNECT_EXISTING')`
    ),
    check(
      'xero_pending_authorisations_binding_ck',
      sql`(${table.flowPurpose} = 'NEW_SOLO' and ${table.existingOrganisationId} is null) or (${table.flowPurpose} = 'CONNECT_EXISTING' and ${table.existingOrganisationId} is not null)`
    ),
    check(
      'xero_pending_authorisations_token_ck',
      sql`jsonb_typeof(${table.encryptedRefreshToken}) = 'object'`
    ),
    check(
      'xero_pending_authorisations_candidates_ck',
      sql`jsonb_typeof(${table.candidateTenants}) = 'array' and jsonb_array_length(${table.candidateTenants}) > 0`
    ),
    check(
      'xero_pending_authorisations_scopes_ck',
      sql`cardinality(${table.grantedScopes}) > 0`
    )
  ]
);

export const xeroConnections = pgTable(
  'xero_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    connectionId: varchar('connection_id', { length: 64 }).notNull(),
    tenantId: varchar('tenant_id', { length: 64 }).notNull(),
    status: varchar('status', { length: 24 })
      .$type<XeroConnectionStatus>()
      .notNull()
      .default('CONNECTED'),
    encryptedRefreshToken: jsonb('encrypted_refresh_token').$type<EncryptedRefreshTokenEnvelope>(),
    grantedScopes: text('granted_scopes').array().notNull(),
    refreshTokenVersion: integer('refresh_token_version').notNull().default(1),
    refreshLeaseId: uuid('refresh_lease_id'),
    refreshLeaseExpiresAt: timestamp('refresh_lease_expires_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex('xero_connections_organisation_uq').on(table.organisationId),
    uniqueIndex('xero_connections_connection_uq').on(table.connectionId),
    uniqueIndex('xero_connections_tenant_uq').on(table.tenantId),
    index('xero_connections_status_idx').on(table.status),
    check(
      'xero_connections_status_ck',
      sql`${table.status} in ('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED')`
    ),
    check(
      'xero_connections_token_state_ck',
      sql`(${table.status} = 'DISCONNECTED' and ${table.encryptedRefreshToken} is null and ${table.refreshLeaseId} is null and ${table.refreshLeaseExpiresAt} is null) or (${table.status} in ('CONNECTED', 'REAUTH_REQUIRED') and ${table.encryptedRefreshToken} is not null and jsonb_typeof(${table.encryptedRefreshToken}) = 'object' and cardinality(${table.grantedScopes}) > 0)`
    ),
    check(
      'xero_connections_token_version_ck',
      sql`${table.refreshTokenVersion} >= 1`
    ),
    check(
      'xero_connections_refresh_lease_ck',
      sql`(${table.refreshLeaseId} is null and ${table.refreshLeaseExpiresAt} is null) or (${table.refreshLeaseId} is not null and ${table.refreshLeaseExpiresAt} is not null and ${table.status} = 'CONNECTED')`
    )
  ]
);
