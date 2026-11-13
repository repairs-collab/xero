import { randomUUID } from 'node:crypto';

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or
} from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  retentionCases,
  smsNumberPool,
  type SubscriptionStatus,
  subscriptions,
  xeroConnections
} from '@bc5000/db';

import { lockRetentionOrganisation } from './retention-legal-hold.js';

export interface SubscriptionRetentionDeadlineInput {
  organisationId: string;
  disconnectedAt: Date;
  retentionDeadline: Date;
  deletionEligibleAt: Date | null;
  closureEffectiveAt: Date;
}

export interface SubscriptionRetentionState {
  status: SubscriptionStatus;
  cancelledAt: Date | null;
  retentionDeadlineRecorded: boolean;
  recordedCancellationAt: Date | null;
}

export interface CancelledSubscriptionLifecycleCandidate {
  organisationId: string;
  cancelledAt: Date;
}

export async function listCancelledSubscriptionsNeedingLifecycle(
  database: Database
): Promise<CancelledSubscriptionLifecycleCandidate[]> {
  const rows = await database
    .select({
      organisationId: subscriptions.organisationId,
      cancelledAt: subscriptions.cancelledAt
    })
    .from(subscriptions)
    .leftJoin(
      retentionCases,
      eq(retentionCases.organisationId, subscriptions.organisationId)
    )
    .leftJoin(
      xeroConnections,
      eq(xeroConnections.organisationId, subscriptions.organisationId)
    )
    .leftJoin(
      smsNumberPool,
      eq(smsNumberPool.organisationId, subscriptions.organisationId)
    )
    .where(
      and(
        eq(subscriptions.status, 'CANCELLED'),
        isNotNull(subscriptions.cancelledAt),
        or(
          isNull(retentionCases.organisationId),
          ne(retentionCases.source, 'SUBSCRIPTION_CANCELLED'),
          lt(retentionCases.closureEffectiveAt, subscriptions.cancelledAt),
          inArray(xeroConnections.status, ['CONNECTED', 'REAUTH_REQUIRED']),
          inArray(smsNumberPool.status, ['RESERVED', 'READY'])
        )
      )
    );
  const candidates = new Map<string, CancelledSubscriptionLifecycleCandidate>();
  for (const row of rows) {
    if (row.cancelledAt !== null) {
      candidates.set(row.organisationId, {
        organisationId: row.organisationId,
        cancelledAt: row.cancelledAt
      });
    }
  }
  return [...candidates.values()];
}

export async function loadSubscriptionRetentionState(
  database: Database,
  organisationId: string
): Promise<SubscriptionRetentionState | null> {
  const [subscription] = await database
    .select({
      status: subscriptions.status,
      cancelledAt: subscriptions.cancelledAt
    })
    .from(subscriptions)
    .where(eq(subscriptions.organisationId, organisationId))
    .limit(1);
  if (subscription === undefined) return null;
  const [retentionCase] = await database
    .select({
      source: retentionCases.source,
      closureEffectiveAt: retentionCases.closureEffectiveAt
    })
    .from(retentionCases)
    .where(eq(retentionCases.organisationId, organisationId))
    .limit(1);
  const [xeroConnection] = await database
    .select({ status: xeroConnections.status })
    .from(xeroConnections)
    .where(eq(xeroConnections.organisationId, organisationId))
    .limit(1);
  const [activeReplyNumber] = await database
    .select({ status: smsNumberPool.status })
    .from(smsNumberPool)
    .where(
      and(
        eq(smsNumberPool.organisationId, organisationId),
        inArray(smsNumberPool.status, ['RESERVED', 'READY'])
      )
    )
    .limit(1);
  const retentionRecorded =
    retentionCase?.source === 'SUBSCRIPTION_CANCELLED';
  const cancellationRecorded =
    retentionRecorded &&
    (xeroConnection === undefined || xeroConnection.status === 'DISCONNECTED') &&
    activeReplyNumber === undefined;
  return {
    ...subscription,
    retentionDeadlineRecorded: cancellationRecorded,
    recordedCancellationAt: retentionRecorded
      ? retentionCase.closureEffectiveAt
      : null
  };
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
    await lockRetentionOrganisation(transaction, input.organisationId);

    const [current] = await transaction
      .select()
      .from(retentionCases)
      .where(eq(retentionCases.organisationId, input.organisationId))
      .for('update')
      .limit(1);
    const currentIsUnboundLegalHold =
      current?.status === 'LEGAL_HOLD' &&
      current.source === 'CUSTOMER_REQUEST' &&
      current.deletionEligibleAt === null;
    if (
      current !== undefined &&
      !currentIsUnboundLegalHold &&
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
