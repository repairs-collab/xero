import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

import { organisations, users } from './organisation.js';

export const platformAdminAuditEvents = pgTable(
  'platform_admin_audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    targetOrganisationId: uuid('target_organisation_id').references(
      () => organisations.id
    ),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: text('entity_id').notNull(),
    reason: text('reason').notNull(),
    beforeValue: jsonb('before_value').$type<Record<string, unknown>>(),
    afterValue: jsonb('after_value').$type<Record<string, unknown>>(),
    correlationId: uuid('correlation_id').defaultRandom().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    index('platform_admin_audit_target_idx').on(
      table.targetOrganisationId,
      table.occurredAt
    ),
    index('platform_admin_audit_actor_idx').on(
      table.actorUserId,
      table.occurredAt
    ),
    index('platform_admin_audit_entity_idx').on(
      table.entityType,
      table.entityId,
      table.occurredAt
    ),
    index('platform_admin_audit_correlation_idx').on(table.correlationId)
  ]
);
