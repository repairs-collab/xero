import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './organisation.js';

export const workerRepairStatuses = [
  'PENDING', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'EXPIRED'
] as const;
export type WorkerRepairStatus = (typeof workerRepairStatuses)[number];

export const workerRepairResults = [
  'ALREADY_HEALTHY',
  'STARTUP_IN_PROGRESS',
  'RESTARTED_HEALTHY',
  'CORRECTED_RELEASE_REQUIRED',
  'SEND_BACKLOG_REVIEW_REQUIRED',
  'RESTART_FAILED',
  'HEALTH_TIMEOUT',
  'OWNER_REVOKED',
  'EXPIRED_BEFORE_START',
  'EXPIRED_AFTER_CLAIM',
  'SERVICE_UNAVAILABLE'
] as const;
export type WorkerRepairResult = (typeof workerRepairResults)[number];

export const workerRepairHealthStates = [
  'HEALTHY', 'STARTING', 'UNHEALTHY', 'DOWN', 'UNVERIFIED'
] as const;
export type WorkerRepairHealth = (typeof workerRepairHealthStates)[number];

export const workerRepairRequests = pgTable('worker_repair_requests', {
  id: uuid('id').primaryKey(),
  requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id),
  status: varchar('status', { length: 16 }).notNull().$type<WorkerRepairStatus>().default('PENDING'),
  resultCode: varchar('result_code', { length: 32 }).$type<WorkerRepairResult>(),
  beforeHealth: varchar('before_health', { length: 16 }).$type<WorkerRepairHealth>(),
  afterHealth: varchar('after_health', { length: 16 }).$type<WorkerRepairHealth>(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
    .default(sql`now() + interval '5 minutes'`),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true })
}, (table) => [
  index('worker_repair_requests_requested_idx').on(table.requestedAt),
  uniqueIndex('worker_repair_requests_one_active_uq')
    .on(sql`(true)`).where(sql`${table.status} in ('PENDING', 'RUNNING')`),
  check('worker_repair_requests_lifecycle_ck', sql`
    (${table.status} = 'PENDING' and ${table.claimedAt} is null and ${table.completedAt} is null and ${table.resultCode} is null)
    or (${table.status} = 'RUNNING' and ${table.claimedAt} is not null and ${table.completedAt} is null and ${table.resultCode} is null)
    or (${table.status} = 'SUCCEEDED' and ${table.claimedAt} is not null and ${table.completedAt} is not null and ${table.resultCode} = 'RESTARTED_HEALTHY' and ${table.resultCode} is not null)
    or (${table.status} = 'SKIPPED' and ${table.completedAt} is not null and ${table.resultCode} in ('ALREADY_HEALTHY', 'STARTUP_IN_PROGRESS', 'CORRECTED_RELEASE_REQUIRED', 'SEND_BACKLOG_REVIEW_REQUIRED', 'OWNER_REVOKED') and ${table.resultCode} is not null)
    or (${table.status} = 'FAILED' and ${table.claimedAt} is not null and ${table.completedAt} is not null and ${table.resultCode} in ('CORRECTED_RELEASE_REQUIRED', 'RESTART_FAILED', 'HEALTH_TIMEOUT', 'SERVICE_UNAVAILABLE') and ${table.resultCode} is not null)
    or (${table.status} = 'EXPIRED' and ${table.completedAt} is not null and ${table.resultCode} in ('EXPIRED_BEFORE_START', 'EXPIRED_AFTER_CLAIM') and ${table.resultCode} is not null)
  `),
  check('worker_repair_requests_claim_ck', sql`
    (${table.claimedAt} is null and ${table.claimExpiresAt} is null)
    or (${table.claimedAt} is not null and ${table.claimExpiresAt} is not null and ${table.claimExpiresAt} > ${table.claimedAt})
  `),
  check('worker_repair_requests_health_ck', sql`
    ${table.beforeHealth} in ('HEALTHY', 'STARTING', 'UNHEALTHY', 'DOWN', 'UNVERIFIED')
    and ${table.afterHealth} in ('HEALTHY', 'STARTING', 'UNHEALTHY', 'DOWN', 'UNVERIFIED')
  `)
]);

export const workerRepairRunner = pgTable('worker_repair_runner', {
  id: smallint('id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull()
}, (table) => [check('worker_repair_runner_singleton_ck', sql`${table.id} = 1`)]);
