import type { SubscriptionStatus } from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';

export interface SubscriptionLifecycleDependencies {
  load(organisationId: string): Promise<{
    status: SubscriptionStatus;
    cancelledAt: Date | null;
    retentionDeadlineRecorded: boolean;
    recordedCancellationAt?: Date | null;
  } | null>;
  disconnectXero(organisationId: string): Promise<void>;
  quarantineSmsNumber(organisationId: string, now: Date): Promise<void>;
  recordRetentionDeadline(input: {
    organisationId: string;
    disconnectedAt: Date;
    retentionDeadline: Date;
    deletionEligibleAt: Date | null;
    closureEffectiveAt: Date;
  }): Promise<void>;
  clock: { now(): Date };
}

export type SubscriptionLifecycleResult =
  | 'DISCONNECTED'
  | 'ALREADY_APPLIED'
  | 'STALE';

const fiveYearAnniversary = (value: Date): Date => {
  const result = new Date(value);
  const day = result.getUTCDate();
  const month = result.getUTCMonth();
  const year = result.getUTCFullYear() + 5;
  result.setUTCDate(1);
  result.setUTCFullYear(year);
  result.setUTCMonth(month);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
};

export const processSubscriptionLifecycle = async (
  dependencies: SubscriptionLifecycleDependencies,
  payload: JobPayloads['subscription.lifecycle']
): Promise<SubscriptionLifecycleResult> => {
  const current = await dependencies.load(payload.organisationId);
  if (current === null || current.status !== 'CANCELLED') return 'STALE';
  if (current.cancelledAt === null) return 'STALE';
  if (
    current.retentionDeadlineRecorded &&
    (current.recordedCancellationAt === undefined ||
      current.recordedCancellationAt === null ||
      current.recordedCancellationAt >= current.cancelledAt)
  ) {
    return 'ALREADY_APPLIED';
  }

  const disconnectedAt = dependencies.clock.now();
  await dependencies.quarantineSmsNumber(
    payload.organisationId,
    disconnectedAt
  );
  await dependencies.disconnectXero(payload.organisationId);
  const retentionDeadline = new Date(
    disconnectedAt.getTime() + 30 * 24 * 60 * 60 * 1000
  );
  const deletionEligibleAt = fiveYearAnniversary(current.cancelledAt);
  await dependencies.recordRetentionDeadline({
    organisationId: payload.organisationId,
    disconnectedAt,
    retentionDeadline,
    deletionEligibleAt,
    closureEffectiveAt: current.cancelledAt
  });
  return 'DISCONNECTED';
};
