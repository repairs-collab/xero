import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubscriptionFailure } from '../../../../server/subscription-service.js';
import { startSoloCheckout } from './actions.js';

const createCheckout = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn((url: string) => {
  throw new Error('redirect:' + url);
}));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('../../../../server/runtime.js', () => ({
  getSubscriptionService: () => Promise.resolve({ createCheckout }),
  requireWebAcceptedSession: () => Promise.resolve({ userId: 'admin' })
}));

describe('start Solo Checkout action', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects a Checkout conflict to a billing notice', async () => {
    createCheckout.mockRejectedValue(new SubscriptionFailure('CHECKOUT_ATTEMPT_CONFLICT'));
    const form = new FormData();
    form.set('organisationId', 'org_solo');
    form.set('billingCadence', 'ANNUAL');

    await expect(startSoloCheckout(form)).rejects.toThrow('redirect:/settings/billing?checkout=attempt-conflict');
  });

  it('keeps redirecting a successful start to the hosted Checkout', async () => {
    createCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/session' });
    const form = new FormData();
    form.set('organisationId', 'org_solo');
    form.set('billingCadence', 'MONTHLY');

    await expect(startSoloCheckout(form)).rejects.toThrow('redirect:https://checkout.stripe.test/session');
  });
});
