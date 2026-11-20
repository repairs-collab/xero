import {
  jobNames,
  subscriptionLifecycleSingletonKey,
  type DurableJobQueue
} from '@bc5000/jobs';

import type { CancelledSubscriptionLifecycleCandidate } from '../services/subscription-retention.js';

export const reconcileCancelledSubscriptionLifecycles = async (dependencies: {
  repository: {
    listCancelledSubscriptionsNeedingLifecycle(): Promise<
      CancelledSubscriptionLifecycleCandidate[]
    >;
  };
  publisher: Pick<DurableJobQueue, 'publish'>;
}): Promise<number> => {
  const candidates =
    await dependencies.repository.listCancelledSubscriptionsNeedingLifecycle();
  for (const candidate of candidates) {
    await dependencies.publisher.publish(
      jobNames.subscriptionLifecycle,
      {
        organisationId: candidate.organisationId,
        status: 'CANCELLED',
        stripeSubscriptionId: candidate.stripeSubscriptionId,
        cancelledAt: candidate.cancelledAt.toISOString()
      },
      {
        singletonKey: subscriptionLifecycleSingletonKey({
          organisationId: candidate.organisationId,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          cancelledAt: candidate.cancelledAt.toISOString()
        }),
        deduplicateWhileActive: true
      }
    );
  }
  return candidates.length;
};

export const reconcileDuePaymentRecoveries = async (dependencies: {
  repository: {
    markDueForReview(input: { now: Date; limit: number }): Promise<number>;
  };
  clock: { now(): Date };
  limit?: number;
}): Promise<number> =>
  dependencies.repository.markDueForReview({
    now: dependencies.clock.now(),
    limit: dependencies.limit ?? 100
  });
