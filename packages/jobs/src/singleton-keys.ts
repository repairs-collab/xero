import { jobNames } from './names.js';

export const subscriptionLifecycleSingletonKey = (input: {
  organisationId: string;
  stripeSubscriptionId: string;
  cancelledAt: string;
}): string =>
  [
    jobNames.subscriptionLifecycle,
    input.organisationId,
    input.stripeSubscriptionId,
    input.cancelledAt
  ].join(':');
