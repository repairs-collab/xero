export type AccountPulseSubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCEL_AT_PERIOD_END'
  | 'CANCELLED'
  | 'INCOMPLETE';

const knownStatuses = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'incomplete',
  'canceled',
  'paused',
  'incomplete_expired'
]);

const terminalStatuses = new Set([
  'canceled',
  'paused',
  'incomplete_expired'
]);

export class StripeStatusFailure extends Error {
  readonly code = 'STRIPE_STATUS_UNSUPPORTED';

  constructor() {
    super('Stripe subscription status is unsupported');
    this.name = 'StripeStatusFailure';
  }
}

export const mapStripeSubscriptionStatus = (
  providerStatus: string,
  cancelAtPeriodEnd: boolean
): AccountPulseSubscriptionStatus => {
  if (!knownStatuses.has(providerStatus)) throw new StripeStatusFailure();
  if (terminalStatuses.has(providerStatus)) return 'CANCELLED';
  if (cancelAtPeriodEnd) return 'CANCEL_AT_PERIOD_END';

  switch (providerStatus) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'incomplete':
      return 'INCOMPLETE';
    default:
      throw new StripeStatusFailure();
  }
};
