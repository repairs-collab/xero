import { jobNames, type DurableJobQueue } from '@bc5000/jobs';

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
        status: 'CANCELLED'
      },
      {
        singletonKey: [
          jobNames.subscriptionLifecycle,
          'cancelled-reconcile',
          candidate.organisationId,
          candidate.cancelledAt.toISOString()
        ].join(':'),
        deduplicateWhileActive: true
      }
    );
  }
  return candidates.length;
};
