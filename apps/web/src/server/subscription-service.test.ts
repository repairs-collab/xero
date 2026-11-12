import { describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { decideAccountEntitlements } from '@bc5000/domain';
import type {
  SoloCheckoutRequest,
  StripeChargeOwnership,
  StripeHostedSession,
  StripeWebhookEvent
} from '@bc5000/integrations/stripe';

import {
  createSubscriptionService,
  decideStripeEventApplication,
  shouldRetireIgnoredReplacementCandidate,
  SubscriptionFailure,
  retainedTrialEnd,
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
  chargeOwnershipRequests: string[] = [];
  chargeOwnership = new Map<string, StripeChargeOwnership>();
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

  loadChargeOwnership(chargeId: string): Promise<StripeChargeOwnership> {
    this.chargeOwnershipRequests.push(chargeId);
    const ownership = this.chargeOwnership.get(chargeId);
    if (!ownership) return Promise.reject(new Error('Missing charge ownership'));
    return Promise.resolve(ownership);
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
  operationalInputs: Parameters<SubscriptionRepository['applyOperationalEvent']>[0][] = [];
  replayInputs: Array<{ eventId: string; payloadHash: string }> = [];
  replayResult: 'ABSENT' | 'DUPLICATE' | 'HASH_MISMATCH' = 'ABSENT';
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

  applyOperationalEvent(
    input: Parameters<SubscriptionRepository['applyOperationalEvent']>[0]
  ): ReturnType<SubscriptionRepository['applyOperationalEvent']> {
    this.operationalInputs.push(input);
    return Promise.resolve(this.applyOutcome);
  }

  lookupEventReplay(input: {
    eventId: string;
    payloadHash: string;
  }): Promise<'ABSENT' | 'DUPLICATE' | 'HASH_MISMATCH'> {
    this.replayInputs.push(input);
    return Promise.resolve(this.replayResult);
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

const invoiceEvent = (
  type: 'invoice.payment_failed' | 'invoice.paid',
  overrides: Record<string, unknown> = {}
): StripeWebhookEvent => ({
  id: `evt_${type.replaceAll('.', '_')}`,
  type,
  created: 1_794_201_600,
  data: {
    object: {
      object: 'invoice',
      id: 'in_solo',
      customer: 'cus_solo',
      currency: 'aud',
      amount_remaining: type === 'invoice.paid' ? 0 : 12_345,
      status: type === 'invoice.paid' ? 'paid' : 'open',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_solo' }
      },
      ...overrides
    }
  }
});

const refundEvent = (
  overrides: Record<string, unknown> = {}
): StripeWebhookEvent => ({
  id: 'evt_charge_refunded',
  type: 'charge.refunded',
  created: 1_794_201_600,
  data: {
    object: {
      object: 'charge',
      id: 'ch_solo',
      customer: 'cus_solo',
      currency: 'aud',
      amount_refunded: 5_000,
      refunded: false,
      ...overrides
    }
  }
});

const disputeEvent = (
  type: 'charge.dispute.created' | 'charge.dispute.closed',
  status: string,
  overrides: Record<string, unknown> = {}
): StripeWebhookEvent => ({
  id: `evt_${type.replaceAll('.', '_')}_${status}`,
  type,
  created: 1_794_201_600,
  data: {
    object: {
      object: 'dispute',
      id: 'dp_solo',
      charge: 'ch_solo',
      currency: 'aud',
      amount: 12_345,
      status,
      ...overrides
    }
  }
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
    ['past_due', true, 'PAST_DUE'],
    ['unpaid', true, 'PAST_DUE'],
    ['incomplete', true, 'INCOMPLETE'],
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
    expect(repository.lifecycleInputs.at(-1)?.stripeProviderStatus).toBe(status);
    if (cancel && (status === 'past_due' || status === 'unpaid' || status === 'incomplete')) {
      expect(decideAccountEntitlements({
        edition: 'SOLO', platformStatus: 'ACTIVE',
        subscriptionStatus: repository.currentAccount!.status, trialEndsAt: null,
        onboardingCompletedVersion: 1, requiredOnboardingVersion: 1,
        replyNumberReady: true, verifiedAdminMobile: '+61412345678',
        acceptedTrialTestSmsParts: 0, now: new Date('2026-11-10T00:00:00Z')
      })).toMatchObject({ canCustomerSend: false, canAutomaticDispatch: false });
    }
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

  it.each([
    ['before', 1794225601, 1],
    ['at', 1794225600, 0]
  ])('only queues scheduled-cancellation provisioning %s the boundary', async (_label, end, count) => {
    const { service, stripe, numberProvisionJobs } = createService();
    stripe.event = subscriptionEvent({ data: { object: {
      ...(subscriptionEvent().data.object as Record<string, unknown>),
      status: 'active', cancel_at_period_end: true,
      current_period_start: end - 1000, current_period_end: end, cancel_at: end
    } } });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe('APPLIED');
    expect(numberProvisionJobs).toHaveLength(count);
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

  it.each([
    [
      'invoice.payment_failed',
      invoiceEvent('invoice.payment_failed'),
      {
        providerObjectType: 'INVOICE',
        providerObjectId: 'in_solo',
        caseKind: 'PAYMENT_FAILURE',
        targetStatus: 'OPEN',
        suspensionPolicy: 'CURRENT_ONLY',
        heldTemplate: 'PAYMENT_FAILED',
        resolveExistingOnly: false,
        amountMinor: 12_345
      }
    ],
    [
      'invoice.paid',
      invoiceEvent('invoice.paid'),
      {
        providerObjectType: 'INVOICE',
        providerObjectId: 'in_solo',
        caseKind: 'PAYMENT_FAILURE',
        targetStatus: 'RESOLVED',
        suspensionPolicy: 'NEVER',
        heldTemplate: 'PAYMENT_RECOVERED',
        resolveExistingOnly: true,
        amountMinor: 0
      }
    ],
    [
      'charge.refunded',
      refundEvent(),
      {
        providerObjectType: 'CHARGE',
        providerObjectId: 'ch_solo',
        caseKind: 'REFUND',
        targetStatus: 'REVIEW_REQUIRED',
        suspensionPolicy: 'NEVER',
        heldTemplate: 'REFUND_RECORDED',
        resolveExistingOnly: false,
        amountMinor: 5_000
      }
    ],
    [
      'charge.dispute.created',
      disputeEvent('charge.dispute.created', 'needs_response'),
      {
        providerObjectType: 'DISPUTE',
        providerObjectId: 'dp_solo',
        caseKind: 'DISPUTE',
        targetStatus: 'OPEN',
        suspensionPolicy: 'ALWAYS',
        heldTemplate: 'DISPUTE_OPENED',
        resolveExistingOnly: false,
        amountMinor: 12_345
      }
    ],
    [
      'charge.dispute.closed won',
      disputeEvent('charge.dispute.closed', 'won'),
      {
        providerObjectType: 'DISPUTE',
        providerObjectId: 'dp_solo',
        caseKind: 'DISPUTE',
        targetStatus: 'RESOLVED',
        suspensionPolicy: 'NEVER',
        heldTemplate: 'DISPUTE_CLOSED',
        resolveExistingOnly: false,
        amountMinor: 12_345
      }
    ],
    [
      'charge.dispute.closed lost',
      disputeEvent('charge.dispute.closed', 'lost'),
      {
        providerObjectType: 'DISPUTE',
        providerObjectId: 'dp_solo',
        caseKind: 'DISPUTE',
        targetStatus: 'REVIEW_REQUIRED',
        suspensionPolicy: 'ALWAYS',
        heldTemplate: 'DISPUTE_CLOSED',
        resolveExistingOnly: false,
        amountMinor: 12_345
      }
    ]
  ] as const)('parses operational Stripe event %s without granting access', async (_label, event, expected) => {
    const { service, stripe, repository, lifecycleJobs, numberProvisionJobs } = createService();
    stripe.event = event;
    stripe.chargeOwnership.set('ch_solo', {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo'
    });

    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe('APPLIED');
    expect(repository.operationalInputs).toHaveLength(1);
    expect(repository.operationalInputs[0]).toMatchObject({
      ...expected,
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      currency: 'aud'
    });
    expect(lifecycleJobs).toEqual([]);
    expect(numberProvisionJobs).toEqual([]);
  });

  it('deduplicates a signed operational replay before any live Stripe ownership read', async () => {
    const { service, stripe, repository } = createService();
    stripe.event = refundEvent();
    repository.replayResult = 'DUPLICATE';

    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe(
      'DUPLICATE'
    );
    expect(repository.replayInputs).toHaveLength(1);
    expect(repository.replayInputs[0]?.eventId).toBe('evt_charge_refunded');
    expect(stripe.chargeOwnershipRequests).toEqual([]);
    expect(repository.operationalInputs).toEqual([]);
  });

  it('fails closed on a signed event ID replay with different payload bytes before live reads', async () => {
    const { service, stripe, repository } = createService();
    stripe.event = disputeEvent('charge.dispute.created', 'needs_response');
    repository.replayResult = 'HASH_MISMATCH';

    await expect(
      service.handleWebhook('{"different":true}', 'signed')
    ).rejects.toMatchObject({ code: 'STRIPE_EVENT_PAYLOAD_MISMATCH' });
    expect(stripe.chargeOwnershipRequests).toEqual([]);
    expect(repository.operationalInputs).toEqual([]);
  });

  it('accepts the legacy invoice subscription field and rejects conflicting identities', async () => {
    const legacy = createService();
    legacy.stripe.event = invoiceEvent('invoice.payment_failed', {
      parent: null,
      subscription: 'sub_legacy'
    });
    await expect(legacy.service.handleWebhook('{}', 'signed')).resolves.toBe('APPLIED');
    expect(legacy.repository.operationalInputs[0]?.stripeSubscriptionId).toBe('sub_legacy');

    const conflict = createService();
    conflict.stripe.event = invoiceEvent('invoice.payment_failed', {
      subscription: 'sub_other'
    });
    await expect(conflict.service.handleWebhook('{}', 'signed')).rejects.toMatchObject({
      code: 'STRIPE_EVENT_INVALID'
    });
    expect(conflict.repository.operationalInputs).toEqual([]);
  });

  it.each([
    ['currency', invoiceEvent('invoice.payment_failed', { currency: 'usd' })],
    ['negative amount', invoiceEvent('invoice.payment_failed', { amount_remaining: -1 })],
    ['fractional amount', refundEvent({ amount_refunded: 1.5 })],
    ['invoice discriminator', invoiceEvent('invoice.payment_failed', { object: 'charge' })],
    ['failed invoice status', invoiceEvent('invoice.payment_failed', { status: 'paid' })],
    ['paid invoice status', invoiceEvent('invoice.paid', { status: 'open' })],
    ['refund discriminator', refundEvent({ object: 'invoice' })],
    ['dispute discriminator', disputeEvent('charge.dispute.created', 'needs_response', { object: 'charge' })],
    ['created dispute status', disputeEvent('charge.dispute.created', 'won')],
    ['closed dispute status', disputeEvent('charge.dispute.closed', 'under_review')]
  ])('rejects malformed operational event %s', async (_label, event) => {
    const { service, stripe, repository } = createService();
    stripe.event = event;
    stripe.chargeOwnership.set('ch_solo', {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo'
    });
    await expect(service.handleWebhook('{}', 'signed')).rejects.toBeInstanceOf(SubscriptionFailure);
    expect(repository.operationalInputs).toEqual([]);
  });

  it('uses charge ownership for refunds and disputes and rejects a customer mismatch', async () => {
    const { service, stripe, repository } = createService();
    stripe.event = refundEvent();
    stripe.chargeOwnership.set('ch_solo', {
      stripeCustomerId: 'cus_other',
      stripeSubscriptionId: 'sub_solo'
    });
    await expect(service.handleWebhook('{}', 'signed')).rejects.toMatchObject({
      code: 'STRIPE_ORGANISATION_MISMATCH'
    });
    expect(stripe.chargeOwnershipRequests).toEqual(['ch_solo']);
    expect(repository.operationalInputs).toEqual([]);
  });

  it('acknowledges genuinely unrelated signed Stripe events without retrying them', async () => {
    const { service, stripe, repository } = createService();
    stripe.event = {
      id: 'evt_product_updated',
      type: 'product.updated',
      created: 1_794_201_600,
      data: { object: { id: 'prod_unrelated' } }
    };

    await expect(service.handleWebhook('{}', 'valid-signature')).resolves.toBe(
      'REJECTED'
    );
    expect(repository.lifecycleInputs).toEqual([]);
    expect(repository.checkoutInputs).toEqual([]);
    expect(repository.operationalInputs).toEqual([]);
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


describe('one-time trial and event safety', () => {
  it('passes only an eligible existing trial deadline to Checkout', async () => {
    const {service, stripe, repository} = createService();
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[0]).toHaveProperty('trialEnd', Math.floor(new Date('2026-11-23T00:00:00Z').getTime()/1000));
    repository.currentAccount = account({ trialEndsAt: new Date('2026-11-09T12:30:00Z') });
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[1]).not.toHaveProperty('trialEnd');
    repository.currentAccount = account({trialEndsAt: null});
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[2]).not.toHaveProperty('trialEnd');
    repository.currentAccount = account({trialEndsAt: new Date('2026-11-11T12:05:00Z')});
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[3]).toHaveProperty('trialEnd');
  });
  it('accepts item-level billing periods', async () => {
    const {service, stripe, repository} = createService();
    const event = subscriptionEvent();
    const object = event.data.object as Record<string, unknown>;
    delete object.current_period_start; delete object.current_period_end;
    const item = ((object.items as {data: Record<string, unknown>[]}).data)[0]!;
    item.current_period_start = 1794201600; item.current_period_end = 1796880000;
    stripe.event = event;
    await expect(service.handleWebhook('{}', 'sig')).resolves.toBe('APPLIED');
    expect(repository.lifecycleInputs[0]?.currentPeriodEnd).toEqual(new Date(1796880000 * 1000));
  });
  it('rejects equal-time status improvements', () => {
    const time = new Date('2026-11-09T12:00:00Z');
    const decision = {eventAlreadyProcessed:false, eventCreatedAt:time, lastAppliedAt:time, existingCustomerId:'cus', incomingCustomerId:'cus', existingSubscriptionId:'sub', incomingSubscriptionId:'sub'};
    expect(decideStripeEventApplication({...decision, existingStatus:'PAST_DUE', incomingStatus:'ACTIVE'})).toBe('IGNORED_OUT_OF_ORDER');
    expect(decideStripeEventApplication({...decision, existingStatus:'ACTIVE', incomingStatus:'PAST_DUE'})).toBe('APPLIED');
    expect(decideStripeEventApplication({...decision, existingStatus:'ACTIVE', incomingStatus:'TRIALING'})).toBe('APPLIED');
    expect(decideStripeEventApplication({...decision, existingStatus:'CANCEL_AT_PERIOD_END', incomingStatus:'TRIALING'})).toBe('APPLIED');
    expect(decideStripeEventApplication({...decision, existingStatus:'TRIALING', incomingStatus:'ACTIVE'})).toBe('IGNORED_OUT_OF_ORDER');
    expect(decideStripeEventApplication({...decision, existingStatus:'TRIALING', incomingStatus:'CANCEL_AT_PERIOD_END'})).toBe('IGNORED_OUT_OF_ORDER');
    expect(decideStripeEventApplication({...decision, existingStatus:'ACTIVE', incomingStatus:'CANCEL_AT_PERIOD_END'})).toBe('APPLIED');
  });
});


describe('replacement and trial decisions', () => {
  it('never erases or extends the local trial', () => {
    const local = new Date('2026-11-23T00:00:00Z');
    expect(retainedTrialEnd(local, null)).toEqual(local);
    expect(retainedTrialEnd(local, new Date('2026-12-01T00:00:00Z'))).toEqual(local);
    expect(retainedTrialEnd(local, new Date('2026-11-20T00:00:00Z'))).toEqual(new Date('2026-11-20T00:00:00Z'));
    expect(retainedTrialEnd(null, local)).toBeNull();
  });
  it('allows replacement only for a cancelled same-customer account and never a retired ID', () => {
    const input = {eventAlreadyProcessed:false, eventCreatedAt:new Date('2026-11-10T00:00:00Z'), lastAppliedAt:new Date('2026-11-09T00:00:00Z'), existingCustomerId:'cus', incomingCustomerId:'cus', existingSubscriptionId:'old', incomingSubscriptionId:'new', existingStatus:'CANCELLED' as const, allowReplacement:true};
    expect(decideStripeEventApplication(input)).toBe('APPLIED');
    expect(decideStripeEventApplication({...input, isRetired:true})).toBe('REJECTED');
    expect(decideStripeEventApplication({...input, incomingCustomerId:'other'})).toBe('REJECTED');
    expect(decideStripeEventApplication({...input, existingCustomerId:null})).toBe('REJECTED');
    expect(decideStripeEventApplication({...input, existingStatus:'ACTIVE'})).toBe('REJECTED');
  });
});


describe('checkout replacement ordering', () => {
  it('ignores older and equal-time distinct replacements but permits a repeat binding', () => {
    const latest = new Date('2026-11-09T11:00:00Z');
    const input = {eventAlreadyProcessed:false, eventCreatedAt:latest, lastAppliedAt:new Date('2026-11-09T10:00:00Z'), lastAppliedCheckoutAt:latest, existingCustomerId:'cus', incomingCustomerId:'cus', existingSubscriptionId:'sub_b', incomingSubscriptionId:'sub_a', existingStatus:'CANCELLED' as const, allowReplacement:true};
    expect(decideStripeEventApplication(input)).toBe('IGNORED_OUT_OF_ORDER');
    expect(decideStripeEventApplication({...input, eventCreatedAt:new Date('2026-11-09T10:30:00Z')})).toBe('IGNORED_OUT_OF_ORDER');
    expect(decideStripeEventApplication({...input, eventCreatedAt:new Date('2026-11-09T12:00:00Z')})).toBe('APPLIED');
    expect(decideStripeEventApplication({...input, incomingSubscriptionId:'sub_b'})).toBe('APPLIED');
  });

  it('retires only ignored same-customer replacement candidates', () => {
    const candidate = {
      outcome: 'IGNORED_OUT_OF_ORDER' as const,
      existingStatus: 'CANCELLED' as const,
      existingCustomerId: 'cus_same',
      incomingCustomerId: 'cus_same',
      existingSubscriptionId: 'sub_bound',
      incomingSubscriptionId: 'sub_stale'
    };

    expect(shouldRetireIgnoredReplacementCandidate(candidate)).toBe(true);
    expect(
      shouldRetireIgnoredReplacementCandidate({
        ...candidate,
        outcome: 'REJECTED'
      })
    ).toBe(false);
    expect(
      shouldRetireIgnoredReplacementCandidate({
        ...candidate,
        incomingCustomerId: 'cus_other'
      })
    ).toBe(false);
    expect(
      shouldRetireIgnoredReplacementCandidate({
        ...candidate,
        incomingSubscriptionId: 'sub_bound'
      })
    ).toBe(false);
  });
});
