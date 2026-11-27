import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Database, DbTransaction } from '../connection.js';
import {
  lifecycleEmailOutbox,
  organisations,
  type LifecycleEmailStatus,
  type LifecycleEmailTemplate
} from '../schema/index.js';

export const lifecycleEmailFailureCategories = [
  'NONE',
  'DELIVERY_RETRY',
  'DELIVERY_REJECTED',
  'DELIVERY_UNCERTAIN',
  'PRE_ACTIVATION',
  'OTHER'
] as const;

export type LifecycleEmailFailureCategory =
  (typeof lifecycleEmailFailureCategories)[number];

export interface LifecycleEmailMonitoringMetrics {
  pendingOrRetry: number;
  unknown: number;
  failedLast24Hours: number;
  sentLast24Hours: number;
}

export interface LifecycleEmailMonitoringRow {
  id: string;
  organisationId: string;
  organisationName: string;
  template: LifecycleEmailTemplate;
  status: LifecycleEmailStatus;
  attempts: number;
  availableAt: Date;
  expiresAt: Date;
  nextAttemptAt: Date | null;
  lastAttemptedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  failureCategory: LifecycleEmailFailureCategory;
}

export interface LifecycleEmailMonitoringSnapshot {
  metrics: LifecycleEmailMonitoringMetrics;
  rows: readonly LifecycleEmailMonitoringRow[];
}

export interface LifecycleEmailMonitoringInput {
  now: Date;
  since: Date;
  limit: number;
}

export interface LifecycleEmailMonitoringRepository {
  readSnapshot(
    input: LifecycleEmailMonitoringInput
  ): Promise<LifecycleEmailMonitoringSnapshot>;
}

type EmailDatabase = Database | DbTransaction;

const failureCategory = sql<LifecycleEmailFailureCategory>`case
  when ${lifecycleEmailOutbox.lastFailureCode} is null then 'NONE'
  when ${lifecycleEmailOutbox.lastFailureCode} = 'PRE_ACTIVATION_NOTICE' then 'PRE_ACTIVATION'
  when ${lifecycleEmailOutbox.lastFailureCode} in (
    'SMTP_CONNECTION_FAILURE',
    'SMTP_AUTH_FAILURE',
    'SMTP_TEMPORARY_REJECTION',
    'JOB_CANCELLED_BEFORE_SUBMISSION'
  ) then 'DELIVERY_RETRY'
  when ${lifecycleEmailOutbox.lastFailureCode} in (
    'INVALID_RECIPIENT',
    'INVALID_TEMPLATE',
    'SMTP_PERMANENT_REJECTION'
  ) then 'DELIVERY_REJECTED'
  when ${lifecycleEmailOutbox.lastFailureCode} in (
    'SMTP_ACCEPTANCE_UNCONFIRMED',
    'SMTP_SUBMISSION_UNCERTAIN',
    'STALE_SENDING'
  ) then 'DELIVERY_UNCERTAIN'
  else 'OTHER'
end`;

const firstCount = (rows: Array<{ value: number }>): number =>
  rows[0]?.value ?? 0;

export class PostgresLifecycleEmailMonitoringRepository
implements LifecycleEmailMonitoringRepository {
  constructor(private readonly database: EmailDatabase) {}

  async readSnapshot(
    input: LifecycleEmailMonitoringInput
  ): Promise<LifecycleEmailMonitoringSnapshot> {
    if (
      !Number.isFinite(input.now.getTime()) ||
      !Number.isFinite(input.since.getTime()) ||
      input.since >= input.now ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    ) {
      throw new Error('LIFECYCLE_EMAIL_MONITORING_INVALID_INPUT');
    }

    const [pendingOrRetry, unknown, failedLast24Hours, sentLast24Hours, rows] =
      await Promise.all([
        this.database
          .select({ value: count() })
          .from(lifecycleEmailOutbox)
          .where(inArray(lifecycleEmailOutbox.status, ['PENDING', 'RETRY'])),
        this.database
          .select({ value: count() })
          .from(lifecycleEmailOutbox)
          .where(eq(lifecycleEmailOutbox.status, 'UNKNOWN')),
        this.database
          .select({ value: count() })
          .from(lifecycleEmailOutbox)
          .where(and(
            eq(lifecycleEmailOutbox.status, 'FAILED'),
            gte(lifecycleEmailOutbox.updatedAt, input.since)
          )),
        this.database
          .select({ value: count() })
          .from(lifecycleEmailOutbox)
          .where(and(
            eq(lifecycleEmailOutbox.status, 'SENT'),
            gte(lifecycleEmailOutbox.sentAt, input.since)
          )),
        this.database
          .select({
            id: lifecycleEmailOutbox.id,
            organisationId: lifecycleEmailOutbox.organisationId,
            organisationName: organisations.name,
            template: lifecycleEmailOutbox.template,
            status: lifecycleEmailOutbox.status,
            attempts: lifecycleEmailOutbox.attempts,
            availableAt: lifecycleEmailOutbox.availableAt,
            expiresAt: lifecycleEmailOutbox.expiresAt,
            nextAttemptAt: lifecycleEmailOutbox.nextAttemptAt,
            lastAttemptedAt: lifecycleEmailOutbox.lastAttemptedAt,
            sentAt: lifecycleEmailOutbox.sentAt,
            createdAt: lifecycleEmailOutbox.createdAt,
            updatedAt: lifecycleEmailOutbox.updatedAt,
            failureCategory: failureCategory.as('failure_category')
          })
          .from(lifecycleEmailOutbox)
          .innerJoin(
            organisations,
            eq(organisations.id, lifecycleEmailOutbox.organisationId)
          )
          .orderBy(
            desc(lifecycleEmailOutbox.updatedAt),
            desc(lifecycleEmailOutbox.id)
          )
          .limit(input.limit)
      ]);

    return {
      metrics: {
        pendingOrRetry: firstCount(pendingOrRetry),
        unknown: firstCount(unknown),
        failedLast24Hours: firstCount(failedLast24Hours),
        sentLast24Hours: firstCount(sentLast24Hours)
      },
      rows
    };
  }
}
