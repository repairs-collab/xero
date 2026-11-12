import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  organisations,
  retentionCases
} from '@bc5000/db';

export interface SubscriptionRetentionDeadlineInput {
  organisationId: string;
  disconnectedAt: Date;
  retentionDeadline: Date;
  deletionEligibleAt: Date | null;
  closureEffectiveAt: Date;
}

/**
 * Records only a trusted newer cancellation episode. The organisation lock
 * makes concurrent lifecycle jobs converge, while the audit event preserves
 * the superseded episode after the current-row pointer advances.
 */
export async function recordSubscriptionRetentionDeadline(
  database: Database,
  input: SubscriptionRetentionDeadlineInput
): Promise<'RECORDED' | 'STALE'> {
  return database.transaction(async (transaction) => {
    const [organisation] = await transaction
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .for('update')
      .limit(1);
    if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');

    const [current] = await transaction
      .select()
      .from(retentionCases)
      .where(eq(retentionCases.organisationId, input.organisationId))
      .limit(1);
    if (
      current !== undefined &&
      current.closureEffectiveAt >= input.closureEffectiveAt
    ) {
      return 'STALE';
    }

    const closureEpisodeId = randomUUID();
    const closureVersion = (current?.closureVersion ?? 0) + 1;
    if (current === undefined) {
      await transaction.insert(retentionCases).values({
        organisationId: input.organisationId,
        source: 'SUBSCRIPTION_CANCELLED',
        status: 'SCHEDULED',
        disconnectedAt: input.disconnectedAt,
        reviewAfter: input.retentionDeadline,
        closureEpisodeId,
        closureVersion,
        closureEffectiveAt: input.closureEffectiveAt,
        deletionEligibleAt: input.deletionEligibleAt,
        createdAt: input.disconnectedAt,
        updatedAt: input.disconnectedAt
      });
    } else {
      await transaction
        .update(retentionCases)
        .set({
          source: 'SUBSCRIPTION_CANCELLED',
          status:
            current.status === 'LEGAL_HOLD' ? 'LEGAL_HOLD' : 'SCHEDULED',
          disconnectedAt: input.disconnectedAt,
          reviewAfter: input.retentionDeadline,
          closureEpisodeId,
          closureVersion,
          closureEffectiveAt: input.closureEffectiveAt,
          deletionEligibleAt: input.deletionEligibleAt,
          backupExpiryVerifiedAt: null,
          backupExpiryEvidenceReference: null,
          backupExpiryClosureEpisodeId: null,
          reviewAttempts: 0,
          lastReviewedAt: null,
          lastReviewError: null,
          updatedAt: input.disconnectedAt
        })
        .where(eq(retentionCases.organisationId, input.organisationId));
    }

    await transaction.insert(auditEvents).values({
      organisationId: input.organisationId,
      eventType: 'SUBSCRIPTION_RETENTION_SCHEDULED',
      entityType: 'RETENTION_EPISODE',
      entityId: closureEpisodeId,
      beforeValue:
        current === undefined
          ? null
          : {
              closureEpisodeId: current.closureEpisodeId,
              closureVersion: current.closureVersion,
              closureEffectiveAt: current.closureEffectiveAt.toISOString(),
              deletionEligibleAt:
                current.deletionEligibleAt?.toISOString() ?? null,
              backupExpiryVerifiedAt:
                current.backupExpiryVerifiedAt?.toISOString() ?? null,
              backupExpiryEvidenceReference:
                current.backupExpiryEvidenceReference,
              status: current.status
            },
      afterValue: {
        closureEpisodeId,
        closureVersion,
        closureEffectiveAt: input.closureEffectiveAt.toISOString(),
        disconnectedAt: input.disconnectedAt.toISOString(),
        retentionDeadline: input.retentionDeadline.toISOString(),
        deletionEligibleAt: input.deletionEligibleAt?.toISOString() ?? null,
        staleBackupEvidenceCleared:
          current?.backupExpiryVerifiedAt !== undefined &&
          current.backupExpiryVerifiedAt !== null
      },
      occurredAt: input.disconnectedAt
    });
    return 'RECORDED';
  });
}
