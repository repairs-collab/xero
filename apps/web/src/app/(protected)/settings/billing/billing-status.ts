import { hasPaidSubscriptionAccess } from '@bc5000/domain';
import type { BillingAccount } from '../../../../server/subscription-service.js';

export const billingStatus = (account: BillingAccount, now: Date) => {
  const unavailable = account.status === 'CANCEL_AT_PERIOD_END' && !hasPaidSubscriptionAccess({ subscriptionStatus: account.status, stripeProviderStatus: account.stripeProviderStatus ?? null, currentPeriodEnd: account.currentPeriodEnd, cancelAt: account.cancelAt, now });
  const ended = unavailable && account.stripeProviderStatus === 'active' && account.currentPeriodEnd !== null && (account.currentPeriodEnd.getTime() <= now.getTime() || (account.cancelAt !== null && account.cancelAt.getTime() <= now.getTime()));
  if (ended) return { status: 'CANCELLED' as const, warning: 'ended' as const };
  return { status: unavailable ? 'INCOMPLETE' as const : account.status, warning: unavailable || account.status === 'PAST_DUE' || account.status === 'INCOMPLETE' ? 'payment' as const : 'none' as const };
};
