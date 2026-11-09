import { describe, expect, it } from 'vitest';

import type { AccountEntitlements } from '@bc5000/domain';

import { decideOutboundEntitlement } from './outbound-entitlement.js';

const entitlement = (
  overrides: Partial<AccountEntitlements> = {}
): AccountEntitlements => ({
  canRead: true,
  canPreview: true,
  canVerifiedAdminTest: true,
  canCustomerSend: false,
  canAutomaticDispatch: false,
  verifiedAdminMobile: '+61412345678',
  remainingTrialTestSmsParts: 10,
  blocker: 'SUBSCRIPTION_REQUIRED',
  ...overrides
});

describe('final outbound entitlement decision', () => {
  it('permits only the verified Administrator destination during trial', () => {
    expect(
      decideOutboundEntitlement(entitlement(), {
        source: 'TEST_SMS',
        destination: '+61412345678',
        automatic: false
      })
    ).toEqual({ kind: 'verified-admin-test' });
    expect(
      decideOutboundEntitlement(entitlement(), {
        source: 'TEST_SMS',
        destination: '+61499999999',
        automatic: false
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'VERIFIED_ADMIN_MOBILE_REQUIRED'
    });
  });

  it('blocks customer sends and exhausted trial tests with stable reasons', () => {
    expect(
      decideOutboundEntitlement(entitlement(), {
        source: 'MANUAL_REMINDER',
        destination: '+61499999999',
        automatic: false
      })
    ).toEqual({ kind: 'blocked', reason: 'SUBSCRIPTION_REQUIRED' });
    expect(
      decideOutboundEntitlement(
        entitlement({
          canVerifiedAdminTest: false,
          remainingTrialTestSmsParts: 0
        }),
        {
          source: 'TEST_SMS',
          destination: '+61412345678',
          automatic: false
        }
      )
    ).toEqual({ kind: 'blocked', reason: 'TRIAL_TEST_LIMIT_REACHED' });
    expect(
      decideOutboundEntitlement(
        entitlement({ remainingTrialTestSmsParts: 1 }),
        {
          source: 'TEST_SMS',
          destination: '+61412345678',
          automatic: false,
          smsPartCount: 2
        }
      )
    ).toEqual({ kind: 'blocked', reason: 'TRIAL_TEST_LIMIT_REACHED' });
  });

  it('allows paid customer paths only after the account capability is active', () => {
    const active = entitlement({
      canCustomerSend: true,
      canAutomaticDispatch: true,
      remainingTrialTestSmsParts: null,
      blocker: null
    });
    expect(
      decideOutboundEntitlement(active, {
        source: 'XERO_EMAIL',
        destination: 'customer@example.invalid',
        automatic: true
      })
    ).toEqual({ kind: 'customer-policy' });
  });

  it('keeps platform-funded verification outside customer entitlements', () => {
    expect(
      decideOutboundEntitlement(
        entitlement({
          canRead: false,
          canPreview: false,
          canVerifiedAdminTest: false,
          verifiedAdminMobile: null,
          remainingTrialTestSmsParts: 0,
          blocker: 'TRIAL_EXPIRED'
        }),
        {
          source: 'VERIFICATION_OTP',
          destination: '+61412345678',
          automatic: false
        }
      )
    ).toEqual({ kind: 'platform-verification' });
  });
});
