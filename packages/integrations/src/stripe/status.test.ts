import { describe, expect, it } from 'vitest';

import { mapStripeSubscriptionStatus, StripeStatusFailure } from './status.js';

describe('mapStripeSubscriptionStatus', () => {
  it.each([
    ['trialing', false, 'TRIALING'],
    ['active', false, 'ACTIVE'],
    ['past_due', false, 'PAST_DUE'],
    ['unpaid', false, 'PAST_DUE'],
    ['incomplete', false, 'INCOMPLETE'],
    ['canceled', false, 'CANCELLED'],
    ['paused', false, 'CANCELLED'],
    ['incomplete_expired', false, 'CANCELLED'],
    ['trialing', true, 'TRIALING'],
    ['active', true, 'CANCEL_AT_PERIOD_END'],
    ['past_due', true, 'PAST_DUE'],
    ['unpaid', true, 'PAST_DUE'],
    ['incomplete', true, 'INCOMPLETE'],
    ['canceled', true, 'CANCELLED'],
    ['paused', true, 'CANCELLED'],
    ['incomplete_expired', true, 'CANCELLED']
  ] as const)(
    'maps %s with cancel-at-period-end=%s to %s',
    (providerStatus, cancelAtPeriodEnd, expected) => {
      expect(
        mapStripeSubscriptionStatus(providerStatus, cancelAtPeriodEnd)
      ).toBe(expected);
    }
  );

  it.each(['', 'pending', 'expired', 'ACTIVE'])('fails closed for %s', (status) => {
    expect(() => mapStripeSubscriptionStatus(status, false)).toThrow(
      StripeStatusFailure
    );
    expect(() => mapStripeSubscriptionStatus(status, true)).toThrow(
      StripeStatusFailure
    );
  });
});
