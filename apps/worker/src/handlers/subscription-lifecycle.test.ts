import { describe, expect, it, vi } from 'vitest';

import { processSubscriptionLifecycle } from './subscription-lifecycle.js';

const cancelledAt = new Date('2027-04-10T04:00:00.000Z');
const payload = {
  organisationId: 'org_solo',
  status: 'CANCELLED' as const,
  stripeSubscriptionId: 'sub_cancelled',
  cancelledAt: cancelledAt.toISOString()
};

describe('processSubscriptionLifecycle', () => {
  it('rejects a job for a superseded Stripe cancellation episode before side effects', async () => {
    const applyCancellationEpisode = vi.fn(() => Promise.resolve('APPLIED' as const));
    await expect(processSubscriptionLifecycle({
      load: () => Promise.resolve({
        status: 'CANCELLED', stripeSubscriptionId: 'sub_replacement', cancelledAt,
        retentionDeadlineRecorded: false, recordedCancellationAt: null
      }),
      applyCancellationEpisode,
      clock: { now: () => new Date('2027-04-10T05:00:00.000Z') }
    }, payload)).resolves.toBe('STALE');
    expect(applyCancellationEpisode).not.toHaveBeenCalled();
  });

  it('does not tear down a subscription reactivated after the initial read', async () => {
    const applyCancellationEpisode = vi.fn(() => Promise.resolve('STALE' as const));
    await expect(processSubscriptionLifecycle({
      load: () => Promise.resolve({
        status: 'CANCELLED', stripeSubscriptionId: payload.stripeSubscriptionId,
        cancelledAt, retentionDeadlineRecorded: false, recordedCancellationAt: null
      }),
      applyCancellationEpisode,
      clock: { now: () => new Date('2027-04-10T05:00:00.000Z') }
    }, payload)).resolves.toBe('STALE');
    expect(applyCancellationEpisode).toHaveBeenCalledTimes(1);
  });

  it('records five-year deletion eligibility from cancellation while retaining the 30-day review', async () => {
    const applied: unknown[] = [];
    const disconnectedAt = new Date('2026-11-09T12:00:00.000Z');
    const episodeCancelledAt = new Date('2026-11-08T09:30:00.000Z');
    await expect(processSubscriptionLifecycle({
      load: () => Promise.resolve({
        status: 'CANCELLED', stripeSubscriptionId: 'sub_first',
        cancelledAt: episodeCancelledAt, retentionDeadlineRecorded: false,
        recordedCancellationAt: null
      }),
      applyCancellationEpisode: (input) => {
        applied.push(input);
        return Promise.resolve('APPLIED');
      },
      clock: { now: () => disconnectedAt }
    }, {
      organisationId: 'org_solo', status: 'CANCELLED',
      stripeSubscriptionId: 'sub_first',
      cancelledAt: episodeCancelledAt.toISOString()
    })).resolves.toBe('DISCONNECTED');
    expect(applied).toEqual([{
      organisationId: 'org_solo', stripeSubscriptionId: 'sub_first', disconnectedAt,
      retentionDeadline: new Date('2026-12-09T12:00:00.000Z'),
      deletionEligibleAt: new Date('2031-11-08T09:30:00.000Z'),
      closureEffectiveAt: episodeCancelledAt
    }]);
  });

  it('does not apply a scheduled cancellation or stale job', async () => {
    const applyCancellationEpisode = vi.fn(() => Promise.resolve('APPLIED' as const));
    const result = await processSubscriptionLifecycle({
      load: () => Promise.resolve({
        status: 'CANCEL_AT_PERIOD_END', stripeSubscriptionId: payload.stripeSubscriptionId,
        cancelledAt: null, retentionDeadlineRecorded: false, recordedCancellationAt: null
      }),
      applyCancellationEpisode,
      clock: { now: () => new Date('2027-04-10T05:00:00.000Z') }
    }, payload);
    expect(result).toBe('STALE');
    expect(applyCancellationEpisode).not.toHaveBeenCalled();
  });

  it('is idempotent after the exact retention episode was recorded', async () => {
    const applyCancellationEpisode = vi.fn(() => Promise.resolve('APPLIED' as const));
    const result = await processSubscriptionLifecycle({
      load: () => Promise.resolve({
        status: 'CANCELLED', stripeSubscriptionId: payload.stripeSubscriptionId,
        cancelledAt, retentionDeadlineRecorded: true, recordedCancellationAt: cancelledAt
      }),
      applyCancellationEpisode,
      clock: { now: () => new Date('2027-04-10T05:00:00.000Z') }
    }, payload);
    expect(result).toBe('ALREADY_APPLIED');
    expect(applyCancellationEpisode).not.toHaveBeenCalled();
  });

  it('opens a fresh closure episode for a trusted newer cancellation', async () => {
    const applied: Array<{ closureEffectiveAt: Date }> = [];
    const result = await processSubscriptionLifecycle({
      load: () => Promise.resolve({
        status: 'CANCELLED', stripeSubscriptionId: payload.stripeSubscriptionId,
        cancelledAt, retentionDeadlineRecorded: true,
        recordedCancellationAt: new Date('2026-11-08T09:30:00.000Z')
      }),
      applyCancellationEpisode: (input) => {
        applied.push(input);
        return Promise.resolve('APPLIED');
      },
      clock: { now: () => new Date('2027-04-10T05:00:00.000Z') }
    }, payload);
    expect(result).toBe('DISCONNECTED');
    expect(applied).toEqual([expect.objectContaining({
      closureEffectiveAt: cancelledAt,
      deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z')
    })]);
  });

  it('uses the last valid anniversary for a leap-day cancellation', async () => {
    const leapDay = new Date('2028-02-29T09:30:00.000Z');
    let deletionEligibleAt: Date | null = null;
    await processSubscriptionLifecycle({
      load: () => Promise.resolve({
        status: 'CANCELLED', stripeSubscriptionId: 'sub_leap', cancelledAt: leapDay,
        retentionDeadlineRecorded: false, recordedCancellationAt: null
      }),
      applyCancellationEpisode: (input) => {
        deletionEligibleAt = input.deletionEligibleAt;
        return Promise.resolve('APPLIED');
      },
      clock: { now: () => new Date('2028-03-01T00:00:00.000Z') }
    }, {
      organisationId: 'org_leap_day', status: 'CANCELLED',
      stripeSubscriptionId: 'sub_leap', cancelledAt: leapDay.toISOString()
    });
    expect(deletionEligibleAt).toEqual(new Date('2033-02-28T09:30:00.000Z'));
  });
});
