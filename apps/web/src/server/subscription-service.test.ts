import { describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import type {
  SoloCheckoutRequest,
  StripeHostedSession,
  StripeWebhookEvent
} from '@bc5000/integrations/stripe';

import {
  createSubscriptionService,
  decideStripeEventApplication,
  SubscriptionFailure,
  type BillingAccount,
  type StripeBillingGateway,
  type SubscriptionRepository
} from './subscription-service.js';

const adminSession: AppSession = {
  userId: 'user_admin',
  cognitoSubject: 'cognito-admin',
  displayName: 'Admin',
  expiresAt: '2026-11-10T00:00:00.000Z',
  memberships: [{ organisationId: 'org_solo', role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }]
};

const operatorSession: AppSession = {
  ...adminSession,
  userId: 'user_operator',
  memberships: [{ organisationId: 'org_solo', role: 'OPERATOR', active: true, organisationStatus: 'ACTIVE' }]
};

const account = (overrides: Partial<BillingAccount> = {}): BillingAccount => ({
  organisationId: 'org_solo',
  billingEmail: 'owner@example.com',
  edition: 'SOLO',
  planCode: 'SOLO_AU_2000',
  status: 'TRIALING',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialEndsAt: new Date('2026-11-23T00:00:00.000Z'),
  cancelAt: null,
  cancelledAt: null,
  lastStripeEventCreatedAt: null,
  createdAt: new Date('2026-11-09T00:00:00.000Z'),
  ...overrides
});

class FakeStripe implements StripeBillingGateway {
  checkoutRequests: SoloCheckoutRequest[] = [];
  portalCustomers: string[] = [];
  event: StripeWebhookEvent | undefined;

  createSoloCheckout(request: SoloCheckoutRequest): Promise<StripeHostedSession> {
    this.checkoutRequests.push(request);
    return Promise.resolve({
      id: 'cs_solo',
      url: 'https://checkout.stripe.com/c/pay/cs_solo'
    });
  }

  createBillingPortal(customerId: string): Promise<StripeHostedSession> {
    this.portalCustomers.push(customerId);
    return Promise.resolve({
      id: 'bps_solo',
      url: 'https://billing.stripe.com/p/session/bps_solo'
    });
  }

  verifyWebhook(): StripeWebhookEvent {
    if (this.event === undefined) throw new Error('No event configured');
    return this.event;
  }
}

class FakeRepository implements SubscriptionRepository {
  currentAccount: BillingAccount | null = account();
  lifecycleInputs: Parameters<SubscriptionRepository['applyLifecycleEvent']>[0][] = [];
  checkoutInputs: Parameters<SubscriptionRepository['applyCheckoutCompleted']>[0][] = [];
  auditInputs: Parameters<SubscriptionRepository['recordBillingAudit']>[0][] = [];
  rejectedInputs: Parameters<SubscriptionRepository['recordRejectedEvent']>[0][] = [];
  applyOutcome: Awaited<ReturnType<SubscriptionRepository['applyLifecycleEvent']>> =
    'APPLIED';

  loadBillingAccount(
    organisationId: string
  ): Promise<BillingAccount | null> {
    return Promise.resolve(
      this.currentAccount?.organisationId === organisationId
        ? this.currentAccount
        : null
    );
  }

  applyLifecycleEvent(
    input: Parameters<SubscriptionRepository['applyLifecycleEvent']>[0]
  ): ReturnType<SubscriptionRepository['applyLifecycleEvent']> {
    this.lifecycleInputs.push(input);
    if (this.applyOutcome === 'APPLIED' && this.currentAccount !== null) {
      this.currentAccount = {
        ...this.currentAccount,
        status: input.status,
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        trialEndsAt: input.trialEndsAt,
        cancelAt: input.cancelAt,
        cancelledAt: input.cancelledAt,
        lastStripeEventCreatedAt: input.eventCreatedAt
      };
    }
    return Promise.resolve(this.applyOutcome);
  }

  applyCheckoutCompleted(
    input: Parameters<SubscriptionRepository['applyCheckoutCompleted']>[0]
  ): ReturnType<SubscriptionRepository['applyCheckoutCompleted']> {
    this.checkoutInputs.push(input);
    return Promise.resolve(this.applyOutcome);
  }

  recordBillingAudit(
    input: Parameters<SubscriptionRepository['recordBillingAudit']>[0]
  ): Promise<void> {
    this.auditInputs.push(input);
    return Promise.resolve();
  }

  recordRejectedEvent(
    input: Parameters<SubscriptionRepository['recordRejectedEvent']>[0]
  ): Promise<'REJECTED'> {
    this.rejectedInputs.push(input);
    return Promise.resolve('REJECTED');
  }
}

const createService = () => {
  const stripe = new FakeStripe();
  const repository = new FakeRepository();
  const lifecycleJobs: Array<{ organisationId: string; status: string }> = [];
  const numberProvisionJobs: Array<{ organisationId: string }> = [];
  return {
    stripe,
    repository,
    lifecycleJobs,
    numberProvisionJobs,
    service: createSubscriptionService({
      stripe,
      repository,
      soloPriceId: 'price_solo_au_2000',
      clock: { now: () => new Date('2026-11-09T12:00:00.000Z') },
      publishLifecycle: (job) => {
        lifecycleJobs.push(job);
        return Promise.resolve();
      },
      publishNumberProvision: (job) => {
        numberProvisionJobs.push(job);
        return Promise.resolve();
      }
    })
  };
};

const subscriptionEvent = (
  overrides: Partial<StripeWebhookEvent> = {}
): StripeWebhookEvent => ({
  id: 'evt_subscription_active',
  type: 'customer.subscription.updated',
  created: 1_794_201_600,
  data: {
    object: {
      id: 'sub_solo',
      customer: 'cus_solo',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: 1_794_201_600,
      current_period_end: 1_796_880_000,
      trial_end: null,
      cancel_at: null,
      canceled_at: null,
      currency: 'aud',
      metadata: {
        organisation_id: 'org_solo',
        plan_code: 'SOLO_AU_2000'
      },
      items: {
        data: [
          {
            price: {
              id: 'price_solo_au_2000',
              currency: 'aud',
              recurring: { interval: 'month' }
            }
          }
        ]
      }
    }
  },
  ...overrides
});

describe('subscription checkout and portal', () => {
  it('lets an Admin create one idempotent Solo Checkout Session', async () => {
    const { service, stripe, repository } = createService();

    const first = await service.createCheckout(adminSession, 'org_solo');
    const second = await service.createCheckout(adminSession, 'org_solo');

    expect(first.url).toContain('checkout.stripe.com');
    expect(second).toEqual(first);
    expect(stripe.checkoutRequests).toHaveLength(2);
    expect(stripe.checkoutRequests[0]).toMatchObject({
      organisationId: 'org_solo',
      userId: 'user_admin',
      idempotencyKey: stripe.checkoutRequests[1]?.idempotencyKey
    });
    expect(stripe.checkoutRequests[0]?.idempotencyKey).toContain(
      '2026-11-09T00:00:00.000Z'
    );
    expect(repository.currentAccount?.status).toBe('TRIALING');
    expect(repository.auditInputs[0]?.detail).toEqual({
      action: 'CHECKOUT_CREATED',
      planCode: 'SOLO_AU_2000'
    });
  });

  it('rejects Operators and legacy internal organisations', async () => {
    const operator = createService();
    await expect(
      operator.service.createCheckout(operatorSession, 'org_solo')
    ).rejects.toThrow('FORBIDDEN');
    expect(operator.stripe.checkoutRequests).toEqual([]);

    const legacy = createService();
    legacy.repository.currentAccount = account({ edition: 'INTERNAL_LEGACY' });
    await expect(
      legacy.service.createCheckout(adminSession, 'org_solo')
    ).rejects.toBeInstanceOf(SubscriptionFailure);
    expect(legacy.stripe.checkoutRequests).toEqual([]);
  });

  it('opens Billing Portal only for the organisation stored customer', async () => {
    const { service, stripe, repository } = createService();
    repository.currentAccount = account({ stripeCustomerId: 'cus_owned' });

    await expect(service.createPortal(adminSession, 'org_solo')).resolves.toEqual({
      id: 'bps_solo',
      url: 'https://billing.stripe.com/p/session/bps_solo'
    });
    expect(stripe.portalCustomers).toEqual(['cus_owned']);

    repository.currentAccount = account({ stripeCustomerId: null });
    await expect(
      service.createPortal(adminSession, 'org_solo')
    ).rejects.toBeInstanceOf(SubscriptionFailure);
  });

  it('prevents a second Checkout subscription when Stripe already owns one', async () => {
    const { service, stripe, repository } = createService();
    repository.currentAccount = account({
      status: 'ACTIVE',
      stripeCustomerId: 'cus_owned',
      stripeSubscriptionId: 'sub_owned'
    });

    await expect(
      service.createCheckout(adminSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'CHECKOUT_NOT_AVAILABLE' });
    expect(stripe.checkoutRequests).toEqual([]);
  });
});

describe('subscription webhooks', () => {
  it.each([
    ['active', false, 'ACTIVE'],
    ['past_due', false, 'PAST_DUE'],
    ['active', true, 'CANCEL_AT_PERIOD_END'],
    ['canceled', false, 'CANCELLED']
  ] as const)('applies %s / cancel=%s as %s', async (status, cancel, expected) => {
    const {
      service,
      stripe,
      repository,
      lifecycleJobs,
      numberProvisionJobs
    } = createService();
    stripe.event = subscriptionEvent({
      id: `evt_${status}_${String(cancel)}`,
      data: {
        object: {
          ...(subscriptionEvent().data.object as Record<string, unknown>),
          status,
          cancel_at_period_end: cancel,
          cancel_at: cancel ? 1_796_880_000 : null,
          canceled_at: status === 'canceled' ? 1_794_201_600 : null
        }
      }
    });

    await expect(
      service.handleWebhook(Buffer.from('{}'), 'valid-signature')
    ).resolves.toBe('APPLIED');
    expect(repository.lifecycleInputs.at(-1)?.status).toBe(expected);
    expect(lifecycleJobs).toEqual(
      expected === 'CANCELLED'
        ? [{ organisationId: 'org_solo', status: 'CANCELLED' }]
        : []
    );
    expect(numberProvisionJobs).toEqual(
      expected === 'ACTIVE' || expected === 'CANCEL_AT_PERIOD_END'
        ? [{ organisationId: 'org_solo' }]
        : []
    );
  });

  it('re-publishes an idempotent cancellation job when Stripe retries the event', async () => {
    const { service, stripe, repository, lifecycleJobs } = createService();
    repository.applyOutcome = 'DUPLICATE';
    stripe.event = subscriptionEvent({
      id: 'evt_cancelled_retry',
      data: {
        object: {
          ...(subscriptionEvent().data.object as Record<string, unknown>),
          status: 'canceled',
          canceled_at: 1_794_201_600
        }
      }
    });

    await expect(service.handleWebhook('{}', 'valid-signature')).resolves.toBe(
      'DUPLICATE'
    );
    expect(lifecycleJobs).toEqual([
      { organisationId: 'org_solo', status: 'CANCELLED' }
    ]);
  });

  it.each([
    ['price_wrong', 'aud'],
    ['price_solo_au_2000', 'usd']
  ])('rejects an unapproved price/currency: %s %s', async (priceId, currency) => {
    const { service, stripe, repository } = createService();
    const event = subscriptionEvent();
    const object = event.data.object as Record<string, unknown>;
    stripe.event = {
      ...event,
      data: {
        object: {
          ...object,
          currency,
          items: {
            data: [{ price: { id: priceId, currency, recurring: {} } }]
          }
        }
      }
    };

    await expect(
      service.handleWebhook('{}', 'valid-signature')
    ).resolves.toBe('REJECTED');
    expect(repository.lifecycleInputs).toEqual([]);
    expect(repository.rejectedInputs).toHaveLength(1);
  });

  it('records Checkout completion without granting an active subscription', async () => {
    const { service, stripe, repository } = createService();
    stripe.event = {
      id: 'evt_checkout_completed',
      type: 'checkout.session.completed',
      created: 1_794_201_600,
      data: {
        object: {
          id: 'cs_solo',
          customer: 'cus_solo',
          subscription: 'sub_solo',
          client_reference_id: 'org_solo',
          metadata: {
            organisation_id: 'org_solo',
            plan_code: 'SOLO_AU_2000'
          }
        }
      }
    };

    await service.handleWebhook('{}', 'valid-signature');
    expect(repository.checkoutInputs).toHaveLength(1);
    expect(repository.lifecycleInputs).toEqual([]);
    expect(repository.currentAccount?.status).toBe('TRIALING');
  });

  it('acknowledges unrelated signed Stripe events without retrying them', async () => {
    const { service, stripe, repository } = createService();
    stripe.event = {
      id: 'evt_invoice_paid',
      type: 'invoice.paid',
      created: 1_794_201_600,
      data: { object: { id: 'in_invoice' } }
    };

    await expect(service.handleWebhook('{}', 'valid-signature')).resolves.toBe(
      'REJECTED'
    );
    expect(repository.lifecycleInputs).toEqual([]);
    expect(repository.checkoutInputs).toEqual([]);
  });
});

describe('decideStripeEventApplication', () => {
  const candidate = {
    eventAlreadyProcessed: false,
    eventCreatedAt: new Date('2026-11-09T12:00:00.000Z'),
    lastAppliedAt: new Date('2026-11-09T11:00:00.000Z'),
    existingCustomerId: 'cus_solo',
    incomingCustomerId: 'cus_solo',
    existingSubscriptionId: 'sub_solo',
    incomingSubscriptionId: 'sub_solo'
  };

  it('deduplicates, ignores older events and rejects ownership mismatches', () => {
    expect(
      decideStripeEventApplication({
        ...candidate,
        eventAlreadyProcessed: true
      })
    ).toBe('DUPLICATE');
    expect(
      decideStripeEventApplication({
        ...candidate,
        eventCreatedAt: new Date('2026-11-09T10:00:00.000Z')
      })
    ).toBe('IGNORED_OUT_OF_ORDER');
    expect(
      decideStripeEventApplication({
        ...candidate,
        incomingCustomerId: 'cus_other'
      })
    ).toBe('REJECTED');
    expect(decideStripeEventApplication(candidate)).toBe('APPLIED');
  });
});
