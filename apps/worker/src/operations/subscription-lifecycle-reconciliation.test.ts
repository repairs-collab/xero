import { describe, expect, it, vi } from 'vitest';

import { jobNames, parseJobPayload } from '@bc5000/jobs';

import * as reconciliation from './subscription-lifecycle-reconciliation.js';

const { reconcileCancelledSubscriptionLifecycles } = reconciliation;

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
        stripeSubscriptionId: 'sub_cancelled',
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
        status: 'CANCELLED',
        stripeSubscriptionId: 'sub_cancelled',
        cancelledAt: '2027-04-10T04:00:00.000Z'
      },
      {
        singletonKey:
          'subscription.lifecycle:10000000-0000-4000-8000-000000000001:sub_cancelled:2027-04-10T04:00:00.000Z',
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
                stripeSubscriptionId: 'sub_cancelled',
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

describe('failed-payment recovery reconciliation', () => {
  it('defines a strict global recovery-review job payload', () => {
    const paymentRecoveryReconcile = (
      jobNames as typeof jobNames & { paymentRecoveryReconcile?: string }
    ).paymentRecoveryReconcile;
    expect(paymentRecoveryReconcile).toBe('payment-recovery.reconcile');
    if (paymentRecoveryReconcile === undefined) return;
    expect(
      parseJobPayload(
        paymentRecoveryReconcile as keyof typeof import('@bc5000/jobs').jobPayloadSchemas,
        {}
      )
    ).toEqual({});
  });

  it('moves only a bounded batch of due cases into owner review', async () => {
    const reconcileDuePaymentRecoveries = (
      reconciliation as typeof reconciliation & {
        reconcileDuePaymentRecoveries?: (dependencies: {
          repository: {
            markDueForReview(input: {
              now: Date;
              limit: number;
            }): Promise<number>;
          };
          clock: { now(): Date };
          limit?: number;
        }) => Promise<number>;
      }
    ).reconcileDuePaymentRecoveries;
    expect(reconcileDuePaymentRecoveries).toBeTypeOf('function');
    if (reconcileDuePaymentRecoveries === undefined) return;

    const now = new Date('2026-12-12T00:00:00.000Z');
    const markDueForReview = vi.fn().mockResolvedValue(37);
    await expect(
      reconcileDuePaymentRecoveries({
        repository: { markDueForReview },
        clock: { now: () => now },
        limit: 50
      })
    ).resolves.toBe(37);
    expect(markDueForReview).toHaveBeenCalledWith({ now, limit: 50 });
  });
});
