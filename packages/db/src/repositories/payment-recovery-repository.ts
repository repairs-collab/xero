import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { auditEvents, billingCases, organisations } from '../schema/index.js';

export class PostgresPaymentRecoveryRepository {
  constructor(private readonly database: Database) {}

  async markDueForReview(input: {
    now: Date;
    limit: number;
  }): Promise<number> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('PAYMENT_RECOVERY_LIMIT_INVALID');
    }
    const limit = Math.min(input.limit, 500);

    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({
          id: billingCases.id,
          organisationId: billingCases.organisationId
        })
        .from(billingCases)
        .where(
          and(
            eq(billingCases.kind, 'PAYMENT_FAILURE'),
            eq(billingCases.status, 'OPEN'),
            eq(billingCases.subscriptionRelation, 'CURRENT'),
            eq(billingCases.blocksSending, true),
            isNotNull(billingCases.recoveryEndsAt),
            lte(billingCases.recoveryEndsAt, input.now)
          )
        )
        .orderBy(asc(billingCases.recoveryEndsAt), asc(billingCases.id))
        .limit(limit);
      if (candidates.length === 0) return 0;

      const organisationIds = [
        ...new Set(candidates.map((row) => row.organisationId))
      ].sort();
      await transaction
        .select({ id: organisations.id })
        .from(organisations)
        .where(inArray(organisations.id, organisationIds))
        .orderBy(asc(organisations.id))
        .for('update');

      const due = await transaction
        .select({
          id: billingCases.id,
          organisationId: billingCases.organisationId,
          recoveryEndsAt: billingCases.recoveryEndsAt
        })
        .from(billingCases)
        .where(
          and(
            inArray(
              billingCases.id,
              candidates.map((row) => row.id)
            ),
            eq(billingCases.kind, 'PAYMENT_FAILURE'),
            eq(billingCases.status, 'OPEN'),
            eq(billingCases.subscriptionRelation, 'CURRENT'),
            eq(billingCases.blocksSending, true),
            isNotNull(billingCases.recoveryEndsAt),
            lte(billingCases.recoveryEndsAt, input.now)
          )
        )
        .orderBy(asc(billingCases.recoveryEndsAt), asc(billingCases.id))
        .for('update', { skipLocked: true });
      if (due.length === 0) return 0;

      const transitioned = await transaction
        .update(billingCases)
        .set({ status: 'REVIEW_REQUIRED', updatedAt: input.now })
        .where(
          inArray(
            billingCases.id,
            due.map((row) => row.id)
          )
        )
        .returning({
          id: billingCases.id,
          organisationId: billingCases.organisationId,
          recoveryEndsAt: billingCases.recoveryEndsAt
        });

      await transaction.insert(auditEvents).values(
        transitioned.map((row) => ({
          organisationId: row.organisationId,
          eventType: 'PAYMENT_RECOVERY_REVIEW_REQUIRED',
          entityType: 'BILLING_CASE',
          entityId: row.id,
          beforeValue: { status: 'OPEN' },
          afterValue: {
            status: 'REVIEW_REQUIRED',
            recoveryEndsAt: row.recoveryEndsAt?.toISOString() ?? null
          },
          occurredAt: input.now
        }))
      );
      return transitioned.length;
    });
  }
}
