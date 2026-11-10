import type {
  AccountEntitlementBlocker,
  AccountEntitlements,
  ProviderSendSource,
  SmsAllowanceBlocker
} from '@bc5000/domain';

export type EntitlementSendBlocker =
  | AccountEntitlementBlocker
  | SmsAllowanceBlocker
  | 'VERIFIED_ADMIN_MOBILE_REQUIRED'
  | 'TRIAL_TEST_LIMIT_REACHED';

export type OutboundEntitlementDecision =
  | { kind: 'customer-policy' }
  | { kind: 'verified-admin-test' }
  | { kind: 'platform-verification' }
  | { kind: 'blocked'; reason: EntitlementSendBlocker };

export const decideOutboundEntitlement = (
  entitlements: AccountEntitlements,
  input: {
    source: ProviderSendSource;
    destination: string;
    automatic: boolean;
    smsPartCount?: number;
  }
): OutboundEntitlementDecision => {
  if (input.source === 'VERIFICATION_OTP') {
    return { kind: 'platform-verification' };
  }
  if (input.source === 'TEST_SMS' && !entitlements.canCustomerSend) {
    if (
      !entitlements.canVerifiedAdminTest ||
      entitlements.verifiedAdminMobile === null
    ) {
      return {
        kind: 'blocked',
        reason:
          entitlements.remainingTrialTestSmsParts === 0
            ? 'TRIAL_TEST_LIMIT_REACHED'
            : (entitlements.blocker ?? 'VERIFIED_ADMIN_MOBILE_REQUIRED')
      };
    }
    if (input.destination !== entitlements.verifiedAdminMobile) {
      return {
        kind: 'blocked',
        reason: 'VERIFIED_ADMIN_MOBILE_REQUIRED'
      };
    }
    if (
      entitlements.remainingTrialTestSmsParts !== null &&
      (input.smsPartCount ?? 1) > entitlements.remainingTrialTestSmsParts
    ) {
      return { kind: 'blocked', reason: 'TRIAL_TEST_LIMIT_REACHED' };
    }
    return { kind: 'verified-admin-test' };
  }
  if (!entitlements.canCustomerSend) {
    return {
      kind: 'blocked',
      reason: entitlements.blocker ?? 'SUBSCRIPTION_REQUIRED'
    };
  }
  if (input.automatic && !entitlements.canAutomaticDispatch) {
    return {
      kind: 'blocked',
      reason: entitlements.blocker ?? 'ONBOARDING_INCOMPLETE'
    };
  }
  return { kind: 'customer-policy' };
};
