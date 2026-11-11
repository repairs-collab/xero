export type AccountEdition = 'INTERNAL_LEGACY' | 'SOLO';

export type AccountSubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCEL_AT_PERIOD_END'
  | 'CANCELLED'
  | 'INCOMPLETE';

export type AccountEntitlementBlocker =
  | 'ACCOUNT_SUSPENDED'
  | 'SUBSCRIPTION_REQUIRED'
  | 'TRIAL_EXPIRED'
  | 'PAYMENT_PAST_DUE'
  | 'ONBOARDING_INCOMPLETE'
  | 'REPLY_NUMBER_NOT_READY';

export interface AccountEntitlementInput {
  edition: AccountEdition;
  platformStatus: 'ACTIVE' | 'SUSPENDED';
  subscriptionStatus: AccountSubscriptionStatus | null;
  stripeProviderStatus?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAt?: Date | null;
  trialEndsAt: Date | null;
  onboardingCompletedVersion: number | null;
  requiredOnboardingVersion: number;
  replyNumberReady: boolean;
  verifiedAdminMobile: string | null;
  acceptedTrialTestSmsParts: number;
  now: Date;
}

export interface AccountEntitlements {
  canRead: boolean;
  canPreview: boolean;
  canVerifiedAdminTest: boolean;
  canCustomerSend: boolean;
  canAutomaticDispatch: boolean;
  verifiedAdminMobile: string | null;
  remainingTrialTestSmsParts: number | null;
  blocker: AccountEntitlementBlocker | null;
}

const validAustralianMobile = (value: string | null): string | null =>
  value !== null && /^\+614\d{8}$/.test(value) ? value : null;

const readOnly = (
  blocker: AccountEntitlementBlocker
): AccountEntitlements => ({
  canRead: true,
  canPreview: false,
  canVerifiedAdminTest: false,
  canCustomerSend: false,
  canAutomaticDispatch: false,
  verifiedAdminMobile: null,
  remainingTrialTestSmsParts: 0,
  blocker
});

export const hasPaidSubscriptionAccess = (input: {
  subscriptionStatus: AccountSubscriptionStatus | null;
  stripeProviderStatus?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAt?: Date | null;
  now: Date;
}): boolean => {
  if (input.subscriptionStatus === 'ACTIVE') return true;
  if (input.subscriptionStatus !== 'CANCEL_AT_PERIOD_END' || input.stripeProviderStatus !== 'active' || input.currentPeriodEnd == null) return false;
  const now = input.now.getTime();
  return input.currentPeriodEnd.getTime() > now && (input.cancelAt == null || input.cancelAt.getTime() > now);
};

export const decideAccountEntitlements = (
  input: AccountEntitlementInput
): AccountEntitlements => {
  if (input.platformStatus === 'SUSPENDED') {
    return readOnly('ACCOUNT_SUSPENDED');
  }
  if (input.edition === 'INTERNAL_LEGACY') {
    return {
      canRead: true,
      canPreview: true,
      canVerifiedAdminTest: true,
      canCustomerSend: true,
      canAutomaticDispatch: true,
      verifiedAdminMobile: null,
      remainingTrialTestSmsParts: null,
      blocker: null
    };
  }

  const mobile = validAustralianMobile(input.verifiedAdminMobile);
  if (input.subscriptionStatus === 'TRIALING') {
    if (
      input.trialEndsAt === null ||
      input.trialEndsAt.getTime() <= input.now.getTime()
    ) {
      return readOnly('TRIAL_EXPIRED');
    }
    const remaining = Math.max(0, 10 - input.acceptedTrialTestSmsParts);
    return {
      canRead: true,
      canPreview: true,
      canVerifiedAdminTest: mobile !== null && remaining > 0,
      canCustomerSend: false,
      canAutomaticDispatch: false,
      verifiedAdminMobile: mobile,
      remainingTrialTestSmsParts: remaining,
      blocker: 'SUBSCRIPTION_REQUIRED'
    };
  }
  if (input.subscriptionStatus === 'PAST_DUE') {
    return readOnly('PAYMENT_PAST_DUE');
  }
  if (!hasPaidSubscriptionAccess(input)) {
    return readOnly('SUBSCRIPTION_REQUIRED');
  }

  const onboardingComplete =
    input.onboardingCompletedVersion !== null &&
    input.onboardingCompletedVersion >= input.requiredOnboardingVersion;
  if (!onboardingComplete) {
    return {
      ...readOnly('ONBOARDING_INCOMPLETE'),
      canPreview: true,
      canVerifiedAdminTest: mobile !== null,
      verifiedAdminMobile: mobile,
      remainingTrialTestSmsParts: null
    };
  }
  if (!input.replyNumberReady) {
    return {
      ...readOnly('REPLY_NUMBER_NOT_READY'),
      canPreview: true,
      canVerifiedAdminTest: mobile !== null,
      verifiedAdminMobile: mobile,
      remainingTrialTestSmsParts: null
    };
  }
  return {
    canRead: true,
    canPreview: true,
    canVerifiedAdminTest: mobile !== null,
    canCustomerSend: true,
    canAutomaticDispatch: true,
    verifiedAdminMobile: mobile,
    remainingTrialTestSmsParts: null,
    blocker: null
  };
};
