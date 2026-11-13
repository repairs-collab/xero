import { describe, expect, it, vi } from 'vitest';

import { jobNames, parseJobPayload } from '@bc5000/jobs';

import { reconcileCancelledSubscriptionLifecycles } from './subscription-lifecycle-reconciliation.js';

describe('cancelled subscription lifecycle reconciliation', () => {
  it('defines a strict global reconciliation job payload', () => {
    expect(jobNames.subscriptionLifecycleReconcile).toBe(
      'subscription.lifecycle-reconcile'
    );
    expect(
      parseJobPayload(jobNames.subscriptionLifecycleReconcile, {})
    ).toEqual({});
    expect(() =>
      parseJobPayload(jobNames.subscriptionLifecycleReconcile, {
        organisationId: 'not-a-global-job'
      })
    ).toThrow();
  });

  it('publishes a replaceable active-only job for every incomplete cancellation episode', async () => {
    const cancelledAt = new Date('2027-04-10T04:00:00.000Z');
    const list = vi.fn().mockResolvedValue([
      {
        organisationId: '10000000-0000-4000-8000-000000000001',
        cancelledAt
      }
    ]);
    const publish = vi.fn().mockResolvedValue('replacement-job');

    await expect(
      reconcileCancelledSubscriptionLifecycles({
        repository: { listCancelledSubscriptionsNeedingLifecycle: list },
        publisher: { publish }
      })
    ).resolves.toBe(1);

    expect(publish).toHaveBeenCalledWith(
      jobNames.subscriptionLifecycle,
      {
        organisationId: '10000000-0000-4000-8000-000000000001',
        status: 'CANCELLED'
      },
      {
        singletonKey:
          'subscription.lifecycle:cancelled-reconcile:10000000-0000-4000-8000-000000000001:2027-04-10T04:00:00.000Z',
        deduplicateWhileActive: true
      }
    );
  });

  it('propagates a publish failure so reconciliation cannot claim success', async () => {
    await expect(
      reconcileCancelledSubscriptionLifecycles({
        repository: {
          listCancelledSubscriptionsNeedingLifecycle: () =>
            Promise.resolve([
              {
                organisationId: '10000000-0000-4000-8000-000000000001',
                cancelledAt: new Date('2027-04-10T04:00:00.000Z')
              }
            ])
        },
        publisher: {
          publish: vi.fn().mockRejectedValue(new Error('queue unavailable'))
        }
      })
    ).rejects.toThrow('queue unavailable');
  });
});
