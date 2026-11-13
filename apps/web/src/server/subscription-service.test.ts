import { describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { decideAccountEntitlements } from '@bc5000/domain';
import type {
  SoloCheckoutRequest,
  StripeChargeOwnership,
  StripeCheckoutSession,
  StripeHostedSession,
  StripeHostedSetupSession,
  StripeWebhookEvent
} from '@bc5000/integrations/stripe';

import {
  createSubscriptionService,
  decideStripeEventApplication,
  shouldRetireIgnoredReplacementCandidate,
  SubscriptionFailure,
  retainedTrialEnd,
  type BillingAccount,
  type DirectDebitRequestRecord,
  type LegacyDirectDebitReconciliation,
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
  billingCadence: 'MONTHLY',
  status: 'TRIALING',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialEndsAt: new Date('2026-11-23T00:00:00.000Z'),
  cancelAt: null,
  cancelledAt: null,
  lastStripeEventCreatedAt: null,
  initialCardInvoiceId: null,
  initialCardStripeSubscriptionId: null,
  initialCardPaymentSucceededAt: null,
  directDebitStatus: null,
  createdAt: new Date('2026-11-09T00:00:00.000Z'),
  ...overrides
});

class FakeStripe implements StripeBillingGateway {
  checkoutRequests: SoloCheckoutRequest[] = [];
  directDebitSetupRequests: Parameters<
    StripeBillingGateway['createDirectDebitSetup']
  >[0][] = [];
  directDebitActivationRequests: Array<{
    stripeSubscriptionId: string;
    stripePaymentMethodId: string;
    idempotencyKey: string;
  }> = [];
  portalCustomers: string[] = [];
  chargeOwnershipRequests: string[] = [];
  chargeOwnership = new Map<string, StripeChargeOwnership>();
  event: StripeWebhookEvent | undefined;

  checkoutConfiguration(billingCadence: SoloCheckoutRequest['billingCadence']) {
    return {
      priceId: billingCadence === 'MONTHLY' ? 'price_solo_au_2000' : 'price_solo_annual',
      publicOrigin: 'https://example.com',
      automaticTaxEnabled: true
    };
  }

  createSoloCheckout(request: SoloCheckoutRequest): Promise<StripeCheckoutSession> {
    this.checkoutRequests.push(request);
    return this.retrieveSoloCheckout('cs_solo');
  }

  retrieveSoloCheckout(id: string): Promise<StripeCheckoutSession> {
    const request = this.checkoutRequests[0]!;
    return Promise.resolve({
      id,
      organisationId: request.organisationId,
      attemptId: request.attemptId,
      billingCadence: request.billingCadence,
      expiresAt: request.expiresAt,
      status: 'open',
      stripeCustomerId: request.stripeCustomerId ?? null,
      stripeSubscriptionId: null,
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

  createDirectDebitSetup(
    request: Parameters<StripeBillingGateway['createDirectDebitSetup']>[0]
  ): Promise<StripeHostedSetupSession> {
    this.directDebitSetupRequests.push(request);
    const secondAttempt = request.setupAttemptVersion > 1;
    return Promise.resolve({
      id: secondAttempt ? 'cs_becs_setup_v2' : 'cs_becs_setup',
      url: secondAttempt
        ? 'https://checkout.stripe.com/c/setup/cs_becs_setup_v2'
        : 'https://checkout.stripe.com/c/setup/cs_becs_setup',
      expiresAt: new Date(
        secondAttempt
          ? '2026-11-11T12:00:00.000Z'
          : '2026-11-10T12:00:00.000Z'
      )
    });
  }

  activateDirectDebit(request: {
    stripeSubscriptionId: string;
    stripePaymentMethodId: string;
    idempotencyKey: string;
  }): Promise<void> {
    this.directDebitActivationRequests.push(request);
    return Promise.resolve();
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
  directDebitRequest: DirectDebitRequestRecord | null = null;
  directDebitRequestCalls: Array<Record<string, unknown>> = [];
  directDebitSetupPendingCalls: Array<Record<string, unknown>> = [];
  directDebitSetupCheckoutCalls: Parameters<
    SubscriptionRepository['bindDirectDebitSetupCheckout']
  >[0][] = [];
  directDebitMandateCalls: Parameters<
    SubscriptionRepository['confirmDirectDebitMandate']
  >[0][] = [];
  directDebitActivationCalls: Array<Record<string, unknown>> = [];
  directDebitRequesterEmail = 'owner@example.com';
  directDebitRequesterEmailResponses: Array<string | null> = [];
  legacyDirectDebitReconciliation: LegacyDirectDebitReconciliation | null =
    null;
  reconciliationCalls: Parameters<
    SubscriptionRepository['reconcileLegacyDirectDebit']
  >[0][] = [];

  loadBillingAccount(
    organisationId: string
  ): Promise<BillingAccount | null> {
    return Promise.resolve(
      this.currentAccount?.organisationId === organisationId
        ? this.currentAccount
        : null
    );
  }

  checkoutAttempt: Awaited<ReturnType<SubscriptionRepository['reserveCheckout']>> | null = null;
  checkoutReserveCalls = 0;
  checkoutDisposition: 'OPEN' | 'FENCED' | 'RESOLVED' = 'OPEN';

  reserveCheckout(input: Parameters<SubscriptionRepository['reserveCheckout']>[0]) {
    this.checkoutReserveCalls += 1;
    const account = this.currentAccount;
    if (account === null) return Promise.reject(new SubscriptionFailure('SUBSCRIPTION_NOT_FOUND'));
    if (account.edition !== 'SOLO') return Promise.reject(new SubscriptionFailure('BILLING_NOT_APPLICABLE'));
    if (account.stripeSubscriptionId !== null) return Promise.reject(new SubscriptionFailure('CHECKOUT_NOT_AVAILABLE'));
    const attemptId = '4b2d7cdd-536b-41d2-8555-18e902183bc0';
    this.checkoutAttempt ??= {
      request: {
        ...input.configuration,
        organisationId: input.organisationId,
        userId: input.userId,
        customerEmail: account.billingEmail,
        billingCadence: input.billingCadence,
        attemptId,
        expiresAt: new Date('2026-11-09T13:00:00.000Z'),
        idempotencyKey: 'solo-checkout:' + attemptId
      },
      stripeSessionId: null,
      reservedAt: new Date('2026-11-09T12:00:00.000Z')
    };
    return Promise.resolve(this.checkoutAttempt);
  }

  recordCheckoutSession(input: Parameters<SubscriptionRepository['recordCheckoutSession']>[0]) {
    if (this.checkoutAttempt !== null) this.checkoutAttempt.stripeSessionId = input.id;
    return Promise.resolve(this.checkoutDisposition);
  }

  releaseRejectedCheckoutAttempt() {
    this.checkoutAttempt = null;
    return Promise.resolve(true);
  }

  applyCheckoutExpired() {
    return Promise.resolve(this.applyOutcome);
  }

  applyLifecycleEvent(
    input: Parameters<SubscriptionRepository['applyLifecycleEvent']>[0]
  ): ReturnType<SubscriptionRepository['applyLifecycleEvent']> {
    this.lifecycleInputs.push(input);
    if (this.applyOutcome === 'APPLIED' && this.currentAccount !== null) {
      this.currentAccount = {
        ...this.currentAccount,
        status: input.status,
        billingCadence: input.billingCadence,
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

  requestDirectDebit(input: {
    organisationId: string;
    requestedByUserId: string;
    requestedAt: Date;
  }) {
    this.directDebitRequestCalls.push(input);
    this.directDebitRequest ??= {
      id: 'ddr_solo',
      organisationId: input.organisationId,
      stripeSubscriptionId: this.currentAccount?.stripeSubscriptionId ?? 'sub_solo',
      status: 'REQUESTED',
      requestedAt: input.requestedAt,
      setupAttemptVersion: 0,
      setupSessionId: null,
      setupSessionExpiresAt: null,
      setupCheckoutCompletedAt: null,
      setupIntentId: null,
      stripePaymentMethodId: null,
      stripeMandateId: null,
      mandateConfirmedAt: null,
      activatedAt: null
    };
    return Promise.resolve(this.directDebitRequest);
  }

  loadDirectDebitRequest() {
    return Promise.resolve(this.directDebitRequest);
  }

  loadDirectDebitRequesterEmail() {
    return Promise.resolve(
      this.directDebitRequesterEmailResponses.length > 0
        ? (this.directDebitRequesterEmailResponses.shift() ?? null)
        : this.directDebitRequesterEmail
    );
  }

  loadLegacyDirectDebitReconciliation() {
    return Promise.resolve(this.legacyDirectDebitReconciliation);
  }

  reconcileLegacyDirectDebit(
    input: Parameters<SubscriptionRepository['reconcileLegacyDirectDebit']>[0]
  ) {
    this.reconciliationCalls.push(input);
    if (this.legacyDirectDebitReconciliation === null) {
      return Promise.reject(
        new Error('DIRECT_DEBIT_RECONCILIATION_NOT_REQUIRED')
      );
    }
    this.legacyDirectDebitReconciliation = {
      ...this.legacyDirectDebitReconciliation,
      providerReconciledAt: input.reconciledAt,
      providerReconciledByUserId: input.reconciledByUserId,
      providerReconciliationOutcome: input.outcome,
      providerReconciliationReference: input.providerReference
    };
    if (this.currentAccount !== null) {
      this.currentAccount = { ...this.currentAccount, directDebitStatus: null };
    }
    return Promise.resolve(this.legacyDirectDebitReconciliation);
  }

  markDirectDebitSetupPending(
    input: Parameters<SubscriptionRepository['markDirectDebitSetupPending']>[0]
  ) {
    this.directDebitSetupPendingCalls.push(input);
    if (this.directDebitRequest !== null) {
      this.directDebitRequest = {
        ...this.directDebitRequest,
        status: 'SETUP_PENDING',
        setupAttemptVersion: input.setupAttemptVersion,
        setupSessionId: input.setupSessionId,
        setupSessionExpiresAt: input.setupSessionExpiresAt,
        setupCheckoutCompletedAt: null,
        setupIntentId: null
      };
    }
    return Promise.resolve();
  }

  bindDirectDebitSetupCheckout(
    input: Parameters<SubscriptionRepository['bindDirectDebitSetupCheckout']>[0]
  ) {
    this.directDebitSetupCheckoutCalls.push(input);
    if (this.directDebitRequest !== null) {
      this.directDebitRequest = {
        ...this.directDebitRequest,
        setupIntentId: input.setupIntentId,
        setupCheckoutCompletedAt: input.eventCreatedAt
      };
    }
    return Promise.resolve(this.applyOutcome);
  }

  confirmDirectDebitMandate(
    input: Parameters<SubscriptionRepository['confirmDirectDebitMandate']>[0]
  ) {
    this.directDebitMandateCalls.push(input);
    if (this.directDebitRequest !== null) {
      this.directDebitRequest = {
        ...this.directDebitRequest,
        status: 'MANDATE_CONFIRMED',
        setupIntentId: input.setupIntentId,
        stripePaymentMethodId: input.stripePaymentMethodId,
        stripeMandateId: input.stripeMandateId,
        mandateConfirmedAt: input.eventCreatedAt
      };
    }
    return Promise.resolve(this.applyOutcome);
  }

  activateDirectDebit(
    input: Parameters<SubscriptionRepository['activateDirectDebit']>[0]
  ) {
    this.directDebitActivationCalls.push(input);
    if (this.directDebitRequest !== null) {
      this.directDebitRequest = {
        ...this.directDebitRequest,
        status: 'ACTIVE',
        activatedAt: input.activatedAt
      };
    }
    if (this.directDebitRequest === null) {
      return Promise.reject(new Error('Missing direct-debit request'));
    }
    return Promise.resolve(this.directDebitRequest);
  }
}

const createService = (
  clock: { now(): Date } = {
    now: () => new Date('2026-11-09T12:00:00.000Z')
  }
) => {
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
      soloMonthlyPriceId: 'price_solo_au_2000',
      soloAnnualPriceId: 'price_solo_annual',
      verifyPlatformOwner: (userId: string) =>
        Promise.resolve(userId === 'platform_owner'),
      clock,
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

const platformOwnerSession: AppSession = {
  ...adminSession,
  userId: 'platform_owner'
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

    const first = await service.createCheckout(
      adminSession,
      'org_solo',
      'MONTHLY'
    );
    const second = await service.createCheckout(
      adminSession,
      'org_solo',
      'MONTHLY'
    );

    expect(first.url).toContain('checkout.stripe.com');
    expect(second).toEqual(first);
    expect(stripe.checkoutRequests).toHaveLength(1);
    expect(stripe.checkoutRequests[0]).toMatchObject({
      organisationId: 'org_solo',
      userId: 'user_admin',
      billingCadence: 'MONTHLY',
      idempotencyKey: 'solo-checkout:' + stripe.checkoutRequests[0]?.attemptId
    });
    expect(repository.currentAccount?.status).toBe('TRIALING');
    expect(repository.auditInputs[0]?.detail).toEqual({
      action: 'CHECKOUT_CREATED',
      planCode: 'SOLO_AU_2000',
      billingCadence: 'MONTHLY'
    });
  });

  it('selects annual billing explicitly and rejects forged cadences', async () => {
    const annual = createService();

    await annual.service.createCheckout(adminSession, 'org_solo', 'ANNUAL');
    expect(annual.stripe.checkoutRequests[0]).toMatchObject({
      billingCadence: 'ANNUAL'
    });
    expect(annual.stripe.checkoutRequests[0]?.idempotencyKey).toBe(
      'solo-checkout:' + annual.stripe.checkoutRequests[0]?.attemptId
    );

    const forged = createService();
    await expect(
      forged.service.createCheckout(
        adminSession,
        'org_solo',
        'WEEKLY' as never
      )
    ).rejects.toMatchObject({ code: 'BILLING_CADENCE_INVALID' });
    expect(forged.stripe.checkoutRequests).toEqual([]);
  });

  it('never reserves a replacement when a racing webhook already resolved the selected attempt', async () => {
    const { service, repository } = createService();
    repository.checkoutDisposition = 'RESOLVED';

    await expect(
      service.createCheckout(adminSession, 'org_solo', 'MONTHLY')
    ).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    expect(repository.checkoutReserveCalls).toBe(1);
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

describe('request-only direct debit', () => {
  it('blocks every customer and provider action until an owner records provider reconciliation', async () => {
    const { service, repository, stripe } = createService();
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z'),
      directDebitStatus: 'RECONCILIATION_REQUIRED'
    });
    repository.legacyDirectDebitReconciliation = {
      id: 'ddr_legacy',
      organisationId: 'org_solo',
      legacyStatus: 'ACTIVE',
      requestedAt: new Date('2026-10-01T10:00:00.000Z'),
      providerReconciledAt: null,
      providerReconciledByUserId: null,
      providerReconciliationOutcome: null,
      providerReconciliationReference: null
    };

    await expect(
      service.requestDirectDebit(adminSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'DIRECT_DEBIT_RECONCILIATION_REQUIRED' });
    await expect(
      service.createDirectDebitSetup(platformOwnerSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'DIRECT_DEBIT_RECONCILIATION_REQUIRED' });
    await expect(
      service.activateDirectDebit(platformOwnerSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'DIRECT_DEBIT_RECONCILIATION_REQUIRED' });
    expect(repository.directDebitRequestCalls).toEqual([]);
    expect(stripe.directDebitSetupRequests).toEqual([]);
    expect(stripe.directDebitActivationRequests).toEqual([]);

    await expect(
      service.reconcileLegacyDirectDebit(
        adminSession,
        'org_solo',
        'ddr_legacy',
        'NO_LEGACY_DEFAULT',
        'cus_solo|sub_solo|none'
      )
    ).rejects.toMatchObject({ code: 'PLATFORM_OWNER_REQUIRED' });
    await expect(
      service.reconcileLegacyDirectDebit(
        platformOwnerSession,
        'org_solo',
        'ddr_legacy',
        'LEGACY_DEFAULT_STILL_ACTIVE' as never,
        'cus_solo|sub_solo|none'
      )
    ).rejects.toMatchObject({
      code: 'DIRECT_DEBIT_RECONCILIATION_OUTCOME_REQUIRED'
    });
    expect(repository.reconciliationCalls).toEqual([]);
    expect(repository.currentAccount?.directDebitStatus).toBe(
      'RECONCILIATION_REQUIRED'
    );
    await expect(
      service.reconcileLegacyDirectDebit(
        platformOwnerSession,
        'org_solo',
        'ddr_legacy',
        'LEGACY_DEFAULT_REMOVED',
        'card 4242 4242 4242 4242'
      )
    ).rejects.toMatchObject({
      code: 'DIRECT_DEBIT_RECONCILIATION_REFERENCE_REQUIRED'
    });
    expect(repository.reconciliationCalls).toEqual([]);
    await expect(
      service.reconcileLegacyDirectDebit(
        platformOwnerSession,
        'org_solo',
        'ddr_legacy',
        'LEGACY_DEFAULT_REMOVED',
        'cus_solo|sub_solo|pm_legacy'
      )
    ).resolves.toMatchObject({
      providerReconciledByUserId: 'platform_owner',
      providerReconciliationOutcome: 'LEGACY_DEFAULT_REMOVED'
    });
    expect(repository.reconciliationCalls).toEqual([
      expect.objectContaining({
        organisationId: 'org_solo',
        directDebitRequestId: 'ddr_legacy',
        reconciledByUserId: 'platform_owner',
        outcome: 'LEGACY_DEFAULT_REMOVED',
        providerReference: 'cus_solo|sub_solo|pm_legacy'
      })
    ]);
  });

  it('accepts a customer Admin request only after signed initial-card evidence', async () => {
    const { service, repository } = createService();

    await expect(
      service.requestDirectDebit(adminSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'DIRECT_DEBIT_CARD_PAYMENT_REQUIRED' });
    expect(repository.directDebitRequestCalls).toEqual([]);

    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    await expect(
      service.requestDirectDebit(adminSession, 'org_solo')
    ).resolves.toMatchObject({ status: 'REQUESTED' });
    await expect(
      service.requestDirectDebit(operatorSession, 'org_solo')
    ).rejects.toThrow('FORBIDDEN');
    expect(repository.directDebitRequestCalls).toHaveLength(1);
  });

  it('lets only the platform owner create the manual Stripe-hosted setup flow', async () => {
    const { service, repository, stripe } = createService();
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    await service.requestDirectDebit(adminSession, 'org_solo');
    Object.assign(repository.currentAccount!, {
      billingEmail: 'platform-owner@example.com'
    });

    await expect(
      service.createDirectDebitSetup(adminSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'PLATFORM_OWNER_REQUIRED' });
    expect(stripe.directDebitSetupRequests).toEqual([]);

    await expect(
      service.createDirectDebitSetup(platformOwnerSession, 'org_solo')
    ).resolves.toMatchObject({
      id: 'cs_becs_setup',
      deliveryMode: 'MANUAL_CUSTOMER_DELIVERY',
      customerEmail: 'owner@example.com'
    });
    expect(stripe.directDebitSetupRequests[0]).toMatchObject({
      organisationId: 'org_solo',
      userId: 'platform_owner',
      stripeCustomerId: 'cus_solo'
    });
    expect(repository.directDebitSetupPendingCalls).toHaveLength(1);
  });

  it('uses a fresh setup idempotency version after the hosted link expires', async () => {
    let currentTime = new Date('2026-11-09T12:00:00.000Z');
    const { service, repository, stripe } = createService({
      now: () => currentTime
    });
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    await service.requestDirectDebit(adminSession, 'org_solo');
    await service.createDirectDebitSetup(platformOwnerSession, 'org_solo');

    currentTime = new Date('2026-11-10T13:00:00.000Z');
    await service.createDirectDebitSetup(platformOwnerSession, 'org_solo');

    expect(stripe.directDebitSetupRequests).toHaveLength(2);
    expect(stripe.directDebitSetupRequests[1]?.idempotencyKey).not.toBe(
      stripe.directDebitSetupRequests[0]?.idempotencyKey
    );
  });

  it('revalidates the requester immediately before returning setup delivery data', async () => {
    const { service, repository, stripe } = createService();
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    await service.requestDirectDebit(adminSession, 'org_solo');
    repository.directDebitRequesterEmailResponses = [
      'owner@example.com',
      null
    ];

    await expect(
      service.createDirectDebitSetup(platformOwnerSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'DIRECT_DEBIT_REQUESTER_NOT_FOUND' });
    expect(stripe.directDebitSetupRequests).toHaveLength(1);
  });

  it('parses a completed setup-mode Checkout and binds its stored session to the SetupIntent', async () => {
    const { service, repository, stripe } = createService();
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    await service.requestDirectDebit(adminSession, 'org_solo');
    await service.createDirectDebitSetup(platformOwnerSession, 'org_solo');
    stripe.event = {
      id: 'evt_setup_checkout_completed',
      type: 'checkout.session.completed',
      created: 1_794_204_600,
      data: {
        object: {
          id: 'cs_becs_setup',
          object: 'checkout.session',
          mode: 'setup',
          status: 'complete',
          payment_status: 'no_payment_required',
          currency: 'aud',
          payment_method_types: ['au_becs_debit'],
          customer: 'cus_solo',
          client_reference_id: 'org_solo',
          setup_intent: 'seti_becs',
          expires_at: 1_794_291_000,
          metadata: {
            organisation_id: 'org_solo',
            stripe_subscription_id: 'sub_solo',
            direct_debit_request_id: 'ddr_solo',
            direct_debit_setup_version: '1',
            purpose: 'DIRECT_DEBIT_REQUEST'
          }
        }
      }
    };

    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe(
      'APPLIED'
    );
    expect(repository.directDebitSetupCheckoutCalls).toHaveLength(1);
    expect(repository.directDebitSetupCheckoutCalls[0]).toMatchObject({
      setupSessionId: 'cs_becs_setup',
      setupIntentId: 'seti_becs'
    });
    expect(repository.directDebitMandateCalls).toEqual([]);
    expect(stripe.directDebitActivationRequests).toEqual([]);
  });

  it('records signed provider mandate evidence without auto-activating direct debit', async () => {
    const { service, repository, stripe } = createService();
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    await service.requestDirectDebit(adminSession, 'org_solo');
    await service.createDirectDebitSetup(platformOwnerSession, 'org_solo');
    stripe.event = {
      id: 'evt_setup_checkout_before_mandate',
      type: 'checkout.session.completed',
      created: 1_794_204_600,
      data: {
        object: {
          id: 'cs_becs_setup',
          object: 'checkout.session',
          mode: 'setup',
          status: 'complete',
          payment_status: 'no_payment_required',
          currency: 'aud',
          payment_method_types: ['au_becs_debit'],
          customer: 'cus_solo',
          client_reference_id: 'org_solo',
          setup_intent: 'seti_becs',
          expires_at: 1_794_291_000,
          metadata: {
            organisation_id: 'org_solo',
            stripe_subscription_id: 'sub_solo',
            direct_debit_request_id: 'ddr_solo',
            direct_debit_setup_version: '1',
            purpose: 'DIRECT_DEBIT_REQUEST'
          }
        }
      }
    };
    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe(
      'APPLIED'
    );
    stripe.event = {
      id: 'evt_setup_intent_succeeded',
      type: 'setup_intent.succeeded',
      created: 1_794_205_200,
      data: {
        object: {
          object: 'setup_intent',
          id: 'seti_becs',
          customer: 'cus_solo',
          status: 'succeeded',
          payment_method: 'pm_becs',
          mandate: 'mandate_becs',
          payment_method_types: ['au_becs_debit'],
          metadata: {
            organisation_id: 'org_solo',
            stripe_subscription_id: 'sub_solo',
            direct_debit_request_id: 'ddr_solo',
            direct_debit_setup_version: '1',
            purpose: 'DIRECT_DEBIT_REQUEST'
          }
        }
      }
    };

    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe(
      'APPLIED'
    );
    expect(repository.directDebitMandateCalls[0]).toMatchObject({
      setupIntentId: 'seti_becs',
      stripePaymentMethodId: 'pm_becs',
      stripeMandateId: 'mandate_becs'
    });
    expect(repository.directDebitRequest?.status).toBe('MANDATE_CONFIRMED');
    expect(stripe.directDebitActivationRequests).toEqual([]);
  });

  it('lets only the platform owner activate provider-confirmed mandate evidence', async () => {
    const { service, repository, stripe } = createService();
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    repository.directDebitRequest = {
      id: 'ddr_solo',
      organisationId: 'org_solo',
      stripeSubscriptionId: 'sub_solo',
      status: 'REQUESTED',
      requestedAt: new Date('2026-11-09T11:30:00.000Z'),
      setupAttemptVersion: 0,
      setupSessionId: null,
      setupSessionExpiresAt: null,
      setupCheckoutCompletedAt: null,
      setupIntentId: null,
      stripePaymentMethodId: null,
      stripeMandateId: null,
      mandateConfirmedAt: null,
      activatedAt: null
    };

    await expect(
      service.activateDirectDebit(platformOwnerSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'DIRECT_DEBIT_MANDATE_REQUIRED' });
    expect(stripe.directDebitActivationRequests).toEqual([]);

    Object.assign(repository.directDebitRequest, {
      status: 'MANDATE_CONFIRMED',
      setupSessionId: 'cs_becs_setup',
      setupIntentId: 'seti_becs',
      stripePaymentMethodId: 'pm_becs',
      stripeMandateId: 'mandate_becs',
      mandateConfirmedAt: new Date('2026-11-09T11:45:00.000Z')
    });
    await expect(
      service.activateDirectDebit(adminSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'PLATFORM_OWNER_REQUIRED' });
    await expect(
      service.activateDirectDebit(platformOwnerSession, 'org_solo')
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(stripe.directDebitActivationRequests).toEqual([
      {
        stripeSubscriptionId: 'sub_solo',
        stripePaymentMethodId: 'pm_becs',
        idempotencyKey: 'direct-debit-activate:ddr_solo:mandate_becs'
      }
    ]);
  });

  it('gives only the platform owner a tenant-scoped direct-debit operations snapshot', async () => {
    const { service, repository } = createService();
    Object.assign(repository.currentAccount!, {
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo',
      initialCardStripeSubscriptionId: 'sub_solo',
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:00.000Z')
    });
    await service.requestDirectDebit(adminSession, 'org_solo');

    await expect(
      service.getDirectDebitOwnerSnapshot(adminSession, 'org_solo')
    ).rejects.toMatchObject({ code: 'PLATFORM_OWNER_REQUIRED' });
    await expect(
      service.getDirectDebitOwnerSnapshot(platformOwnerSession, 'org_other')
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_FOUND' });
    await expect(
      service.getDirectDebitOwnerSnapshot(platformOwnerSession, 'org_solo')
    ).resolves.toMatchObject({
      organisationId: 'org_solo',
      initialCardInvoiceId: 'in_initial_card',
      request: {
        status: 'REQUESTED',
        requesterEmail: 'owner@example.com'
      }
    });
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
          object: 'checkout.session',
          mode: 'subscription',
          status: 'complete',
          payment_status: 'paid',
          amount_total: 32_890,
          currency: 'aud',
          payment_method_types: ['card'],
          invoice: 'in_initial_card',
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
    expect(repository.checkoutInputs[0]).toMatchObject({
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date(1_794_201_600 * 1000)
    });
    expect(repository.lifecycleInputs).toEqual([]);
    expect(repository.currentAccount?.status).toBe('TRIALING');
  });

  it.each([
    ['wrong mode', { mode: 'payment' }],
    ['unpaid', { payment_status: 'unpaid' }],
    ['incomplete', { status: 'open' }],
    ['zero-credit', { amount_total: 0 }],
    ['wrong currency', { currency: 'usd' }],
    ['non-card method', { payment_method_types: ['au_becs_debit'] }],
    ['missing invoice', { invoice: null }]
  ])('rejects %s Checkout as initial-card evidence', async (_label, override) => {
    const { service, stripe, repository } = createService();
    stripe.event = {
      id: `evt_checkout_invalid_${String(_label).replaceAll(' ', '_')}`,
      type: 'checkout.session.completed',
      created: 1_794_201_600,
      data: {
        object: {
          id: 'cs_solo',
          object: 'checkout.session',
          mode: 'subscription',
          status: 'complete',
          payment_status: 'paid',
          amount_total: 32_890,
          currency: 'aud',
          payment_method_types: ['card'],
          invoice: 'in_initial_card',
          customer: 'cus_solo',
          subscription: 'sub_solo',
          client_reference_id: 'org_solo',
          metadata: {
            organisation_id: 'org_solo',
            plan_code: 'SOLO_AU_2000'
          },
          ...override
        }
      }
    };

    await expect(
      service.handleWebhook('{}', 'valid-signature')
    ).rejects.toMatchObject({ code: 'STRIPE_EVENT_INVALID' });
    expect(repository.checkoutInputs).toEqual([]);
  });

  it('keeps invoice.paid recovery separate when Invoice payment settings are null', async () => {
    const { service, stripe, repository } = createService();
    stripe.event = invoiceEvent('invoice.paid', {
      billing_reason: 'subscription_create',
      amount_paid: 32_890,
      payment_settings: { payment_method_types: null }
    });

    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe(
      'APPLIED'
    );
    expect(repository.operationalInputs[0]).toMatchObject({
      resolveExistingOnly: true
    });
    expect(repository.operationalInputs[0]).not.toHaveProperty(
      'successfulInitialCardPayment'
    );
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

  it.each([
    ['subscription lifecycle', subscriptionEvent()],
    [
      'subscription Checkout',
      {
        id: 'evt_checkout_completed',
        type: 'checkout.session.completed',
        created: 1_794_201_600,
        data: {
          object: {
            id: 'cs_solo',
            object: 'checkout.session',
            mode: 'subscription',
            status: 'complete',
            payment_status: 'paid',
            amount_total: 32_890,
            currency: 'aud',
            payment_method_types: ['card'],
            invoice: 'in_initial_card',
            customer: 'cus_solo',
            subscription: 'sub_solo',
            client_reference_id: 'org_solo',
            metadata: {
              organisation_id: 'org_solo',
              plan_code: 'SOLO_AU_2000'
            }
          }
        }
      } satisfies StripeWebhookEvent
    ]
  ])('rejects a reused %s event ID when the signed payload hash differs', async (_label, event) => {
    const { service, stripe, repository } = createService();
    stripe.event = event;
    repository.replayResult = 'HASH_MISMATCH';

    await expect(
      service.handleWebhook('{"different":true}', 'signed')
    ).rejects.toMatchObject({ code: 'STRIPE_EVENT_PAYLOAD_MISMATCH' });
    expect(repository.lifecycleInputs).toEqual([]);
    expect(repository.checkoutInputs).toEqual([]);
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
  it('never forwards a historical trial deadline to paid Checkout', async () => {
    const {service, stripe, repository} = createService();
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[0]).not.toHaveProperty('trialEnd');
    repository.currentAccount = account({ trialEndsAt: new Date('2026-11-09T12:30:00Z') });
    repository.checkoutAttempt = null;
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[1]).not.toHaveProperty('trialEnd');
    repository.currentAccount = account({trialEndsAt: null});
    repository.checkoutAttempt = null;
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[2]).not.toHaveProperty('trialEnd');
    repository.currentAccount = account({trialEndsAt: new Date('2026-11-11T12:05:00Z')});
    repository.checkoutAttempt = null;
    await service.createCheckout(adminSession, 'org_solo');
    expect(stripe.checkoutRequests[3]).not.toHaveProperty('trialEnd');
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
  it('derives annual cadence only from the exact configured annual Price', async () => {
    const { service, stripe, repository } = createService();
    const event = subscriptionEvent();
    const object = event.data.object as {
      items: {
        data: Array<{
          price: {
            id: string;
            currency: string;
            recurring: { interval: string; interval_count?: number };
          };
        }>;
      };
    };
    object.items.data[0]!.price = {
      id: 'price_solo_annual',
      currency: 'aud',
      recurring: { interval: 'year', interval_count: 1 }
    };
    stripe.event = event;

    await expect(service.handleWebhook('{}', 'sig')).resolves.toBe('APPLIED');
    expect(repository.lifecycleInputs[0]?.billingCadence).toBe('ANNUAL');

    object.items.data[0]!.price.recurring.interval = 'month';
    stripe.event = { ...event, id: 'evt_forged_annual_cadence' };
    await expect(service.handleWebhook('{"forged":true}', 'sig')).resolves.toBe(
      'REJECTED'
    );
    expect(repository.lifecycleInputs).toHaveLength(1);
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
