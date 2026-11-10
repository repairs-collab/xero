import { describe, expect, it } from 'vitest';

import {
  decideAccountEntitlements,
  type AccountEntitlementInput
} from './entitlements.js';

const now = new Date('2026-11-10T00:00:00.000Z');

const solo = (
  overrides: Partial<AccountEntitlementInput> = {}
): AccountEntitlementInput => ({
  edition: 'SOLO',
  subscriptionStatus: 'ACTIVE',
  trialEndsAt: null,
  onboardingCompletedVersion: 1,
  requiredOnboardingVersion: 1,
  replyNumberReady: true,
  verifiedAdminMobile: '+61412345678',
  acceptedTrialTestSmsParts: 0,
  now,
  ...overrides
});

describe('AccountPulse account entitlements', () => {
  it('preserves every existing INTERNAL_LEGACY capability', () => {
    expect(
      decideAccountEntitlements({
        ...solo(),
        edition: 'INTERNAL_LEGACY',
        subscriptionStatus: null,
        onboardingCompletedVersion: null,
        replyNumberReady: false,
        verifiedAdminMobile: null
      })
    ).toEqual({
      canRead: true,
      canPreview: true,
      canVerifiedAdminTest: true,
      canCustomerSend: true,
      canAutomaticDispatch: true,
      verifiedAdminMobile: null,
      remainingTrialTestSmsParts: null,
      blocker: null
    });
  });

  it.each([
    ['ACTIVE', null],
    ['CANCEL_AT_PERIOD_END', null]
  ] as const)('allows a fully onboarded %s Solo account', (status, blocker) => {
    expect(
      decideAccountEntitlements(solo({ subscriptionStatus: status }))
    ).toMatchObject({
      canRead: true,
      canPreview: true,
      canVerifiedAdminTest: true,
      canCustomerSend: true,
      canAutomaticDispatch: true,
      blocker
    });
  });

  it('allows only verified-admin tests during a current trial', () => {
    expect(
      decideAccountEntitlements(
        solo({
          subscriptionStatus: 'TRIALING',
          trialEndsAt: new Date('2026-11-24T00:00:00.000Z'),
          onboardingCompletedVersion: null,
          replyNumberReady: false,
          acceptedTrialTestSmsParts: 7
        })
      )
    ).toEqual({
      canRead: true,
      canPreview: true,
      canVerifiedAdminTest: true,
      canCustomerSend: false,
      canAutomaticDispatch: false,
      verifiedAdminMobile: '+61412345678',
      remainingTrialTestSmsParts: 3,
      blocker: 'SUBSCRIPTION_REQUIRED'
    });
  });

  it('blocks trial tests for the wrong destination or after ten parts', () => {
    expect(
      decideAccountEntitlements(
        solo({
          subscriptionStatus: 'TRIALING',
          trialEndsAt: new Date('2026-11-24T00:00:00.000Z'),
          onboardingCompletedVersion: null,
          replyNumberReady: false,
          acceptedTrialTestSmsParts: 10
        })
      )
    ).toMatchObject({
      canVerifiedAdminTest: false,
      remainingTrialTestSmsParts: 0,
      blocker: 'SUBSCRIPTION_REQUIRED'
    });
    expect(
      decideAccountEntitlements(
        solo({
          subscriptionStatus: 'TRIALING',
          trialEndsAt: new Date('2026-11-24T00:00:00.000Z'),
          onboardingCompletedVersion: null,
          replyNumberReady: false,
          verifiedAdminMobile: null
        })
      )
    ).toMatchObject({ canVerifiedAdminTest: false });
  });

  it.each([
    [
      'expired trial',
      {
        subscriptionStatus: 'TRIALING' as const,
        trialEndsAt: new Date('2026-11-09T23:59:59.000Z')
      },
      'TRIAL_EXPIRED'
    ],
    [
      'past due',
      { subscriptionStatus: 'PAST_DUE' as const },
      'PAYMENT_PAST_DUE'
    ],
    [
      'cancelled',
      { subscriptionStatus: 'CANCELLED' as const },
      'SUBSCRIPTION_REQUIRED'
    ],
    [
      'incomplete',
      { subscriptionStatus: 'INCOMPLETE' as const },
      'SUBSCRIPTION_REQUIRED'
    ]
  ])('makes %s Solo accounts read-only', (_label, overrides, blocker) => {
    expect(decideAccountEntitlements(solo(overrides))).toMatchObject({
      canRead: true,
      canPreview: false,
      canVerifiedAdminTest: false,
      canCustomerSend: false,
      canAutomaticDispatch: false,
      blocker
    });
  });

  it('requires onboarding completion and a ready reply number after payment', () => {
    expect(
      decideAccountEntitlements(
        solo({ onboardingCompletedVersion: null, replyNumberReady: false })
      )
    ).toMatchObject({
      canCustomerSend: false,
      canAutomaticDispatch: false,
      blocker: 'ONBOARDING_INCOMPLETE'
    });
    expect(
      decideAccountEntitlements(solo({ replyNumberReady: false }))
    ).toMatchObject({
      canCustomerSend: false,
      canAutomaticDispatch: false,
      blocker: 'REPLY_NUMBER_NOT_READY'
    });
  });
});
