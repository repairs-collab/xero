import type { SubscriptionStatus } from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';

export interface TrialExpiryDependencies {
  load(organisationId: string): Promise<{
    status: SubscriptionStatus;
    trialEndsAt: Date | null;
    retentionDeadlineRecorded: boolean;
  } | null>;
  pauseScheduledWork(organisationId: string, now: Date): Promise<void>;
  disconnectXero(organisationId: string): Promise<void>;
  recordRetentionDeadline(input: {
    organisationId: string;
    disconnectedAt: Date;
    retentionDeadline: Date;
  }): Promise<void>;
  clock: { now(): Date };
}

export type TrialExpiryResult =
  | 'DISCONNECTED'
  | 'ALREADY_APPLIED'
  | 'STALE';

export const processTrialExpiry = async (
  dependencies: TrialExpiryDependencies,
  payload: JobPayloads['subscription.trial-expiry']
): Promise<TrialExpiryResult> => {
  const current = await dependencies.load(payload.organisationId);
  if (current === null) return 'STALE';
  if (current.retentionDeadlineRecorded) return 'ALREADY_APPLIED';
  const now = dependencies.clock.now();
  if (
    current.status !== 'TRIALING' ||
    current.trialEndsAt === null ||
    current.trialEndsAt.getTime() > now.getTime()
  ) {
    return 'STALE';
  }
  await dependencies.pauseScheduledWork(payload.organisationId, now);
  await dependencies.disconnectXero(payload.organisationId);
  await dependencies.recordRetentionDeadline({
    organisationId: payload.organisationId,
    disconnectedAt: now,
    retentionDeadline: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  });
  return 'DISCONNECTED';
};
