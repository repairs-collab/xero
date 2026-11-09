import type { SubscriptionStatus } from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';

export interface SubscriptionLifecycleDependencies {
  load(organisationId: string): Promise<{
    status: SubscriptionStatus;
    retentionDeadlineRecorded: boolean;
  } | null>;
  disconnectXero(organisationId: string): Promise<void>;
  quarantineSmsNumber(organisationId: string, now: Date): Promise<void>;
  recordRetentionDeadline(input: {
    organisationId: string;
    disconnectedAt: Date;
    retentionDeadline: Date;
  }): Promise<void>;
  clock: { now(): Date };
}

export type SubscriptionLifecycleResult =
  | 'DISCONNECTED'
  | 'ALREADY_APPLIED'
  | 'STALE';

export const processSubscriptionLifecycle = async (
  dependencies: SubscriptionLifecycleDependencies,
  payload: JobPayloads['subscription.lifecycle']
): Promise<SubscriptionLifecycleResult> => {
  const current = await dependencies.load(payload.organisationId);
  if (current === null || current.status !== 'CANCELLED') return 'STALE';
  if (current.retentionDeadlineRecorded) return 'ALREADY_APPLIED';

  const disconnectedAt = dependencies.clock.now();
  await dependencies.quarantineSmsNumber(
    payload.organisationId,
    disconnectedAt
  );
  await dependencies.disconnectXero(payload.organisationId);
  const retentionDeadline = new Date(
    disconnectedAt.getTime() + 30 * 24 * 60 * 60 * 1000
  );
  await dependencies.recordRetentionDeadline({
    organisationId: payload.organisationId,
    disconnectedAt,
    retentionDeadline
  });
  return 'DISCONNECTED';
};
