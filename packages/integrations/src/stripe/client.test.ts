import { describe, expect, it } from 'vitest';

import {
  StripeBillingClient,
  StripeConfigurationFailure,
  StripeProviderFailure,
  StripeWebhookSignatureFailure,
  type StripeApi
} from './client.js';

class FakeStripeApi implements StripeApi {
  checkoutCalls: Array<{
    parameters: Record<string, unknown>;
    options: { idempotencyKey: string };
  }> = [];
  portalCalls: Array<Record<string, unknown>> = [];
  subscriptionUpdateCalls: Array<{
    subscriptionId: string;
    parameters: Record<string, unknown>;
    options: { idempotencyKey: string };
  }> = [];
  webhookCalls: Array<{
    rawBody: string | Buffer;
    signature: string;
    secret: string;
    tolerance: number;
  }> = [];
  webhookFailure: Error | undefined;
  chargeCalls: string[] = [];
  invoicePaymentCalls: Array<Record<string, unknown>> = [];
  chargeFailure: Error | undefined;
  invoicePaymentFailure: Error | undefined;
  chargeResponse: unknown = {
    id: 'ch_invoice_payment',
    object: 'charge',
    customer: 'cus_solo',
    payment_intent: 'pi_invoice_payment'
  };
  invoicePaymentResponse: unknown = {
    object: 'list',
    data: [
      {
        id: 'inpay_solo',
        object: 'invoice_payment',
        payment: {
          type: 'payment_intent',
          payment_intent: 'pi_invoice_payment'
        },
        invoice: {
          id: 'in_solo',
          object: 'invoice',
          customer: 'cus_solo',
          parent: {
            type: 'subscription_details',
            quote_details: null,
            subscription_details: {
              metadata: null,
              subscription: 'sub_solo'
            }
          }
        }
      }
    ],
    has_more: false,
    url: '/v1/invoice_payments'
  };

  checkoutResponse: unknown;
  checkoutFailure: Error | Record<string, unknown> | undefined;
  checkoutRetrieveResponse: unknown;
  checkoutRetrieveCalls: string[] = [];

  checkout = {
    sessions: {
      create: (
        parameters: Record<string, unknown>,
        options: { idempotencyKey: string }
      ) => {
        this.checkoutCalls.push({ parameters, options });
        if (this.checkoutFailure !== undefined) {
          const failure =
            this.checkoutFailure instanceof Error
              ? this.checkoutFailure
              : Object.assign(new Error('Fake Stripe checkout failure'), {
                  ...this.checkoutFailure
                });
          return Promise.reject(failure);
        }
        return Promise.resolve(this.checkoutResponse ?? {
          id: 'cs_solo_checkout',
          object: 'checkout.session',
          mode: parameters.mode,
          status: 'open',
          metadata: parameters.metadata,
          client_reference_id: parameters.client_reference_id,
          customer: parameters.customer ?? null,
          subscription: null,
          url: 'https://checkout.stripe.com/c/pay/cs_solo_checkout',
          expires_at: parameters.expires_at ?? 1_794_312_000
        });
      },
      retrieve: (id: string) => {
        this.checkoutRetrieveCalls.push(id);
        return Promise.resolve(this.checkoutRetrieveResponse);
      }
    }
  };

  billingPortal = {
    sessions: {
      create: (parameters: Record<string, unknown>) => {
        this.portalCalls.push(parameters);
        return Promise.resolve({
          id: 'bps_solo_portal',
          url: 'https://billing.stripe.com/p/session/bps_solo_portal'
        });
      }
    }
  };

  subscriptions = {
    update: (
      subscriptionId: string,
      parameters: Record<string, unknown>,
      options: { idempotencyKey: string }
    ) => {
      this.subscriptionUpdateCalls.push({
        subscriptionId,
        parameters,
        options
      });
      return Promise.resolve({ id: subscriptionId });
    }
  };

  charges = {
    retrieve: (chargeId: string) => {
      this.chargeCalls.push(chargeId);
      if (this.chargeFailure) return Promise.reject(this.chargeFailure);
      return Promise.resolve(this.chargeResponse);
    }
  };

  invoicePayments = {
    list: (parameters: Record<string, unknown>) => {
      this.invoicePaymentCalls.push(parameters);
      if (this.invoicePaymentFailure) {
        return Promise.reject(this.invoicePaymentFailure);
      }
      return Promise.resolve(this.invoicePaymentResponse);
    }
  };

  webhooks = {
    constructEvent: (
      rawBody: string | Buffer,
      signature: string,
      secret: string,
      tolerance: number
    ) => {
      this.webhookCalls.push({ rawBody, signature, secret, tolerance });
      if (this.webhookFailure) throw this.webhookFailure;
      return {
        id: 'evt_subscription_updated',
        type: 'customer.subscription.updated',
        created: 1_794_201_600,
        data: { object: { id: 'sub_solo' } }
      };
    }
  };
}

const createClient = (api: StripeApi): StripeBillingClient =>
  new StripeBillingClient(api, {
    soloMonthlyPriceId: 'price_solo_monthly',
    soloAnnualPriceId: 'price_solo_annual',
    priceCurrency: 'aud',
    automaticTaxEnabled: true,
    portalConfigurationId: 'bpc_solo',
    publicBaseUrl: 'https://ap.motts.com.au',
    webhookSecret: 'whsec_test_only',
    webhookToleranceSeconds: 300
  });

const checkoutAttemptId = 'a05f69ec-0fbb-4bc1-8e1f-ae42f09f117e';
const checkoutRequest = (client: StripeBillingClient, billingCadence: 'MONTHLY' | 'ANNUAL' = 'MONTHLY') => ({
  ...client.checkoutConfiguration(billingCadence),
  organisationId: 'org_solo',
  userId: 'user_owner',
  customerEmail: 'owner@example.com',
  billingCadence,
  attemptId: checkoutAttemptId,
  expiresAt: new Date(1_794_312_000 * 1000),
  idempotencyKey: 'solo-checkout:' + checkoutAttemptId
});

describe('StripeBillingClient checkout', () => {
  it('distinguishes a definitive expires_at validation rejection from an uncertain provider failure', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);
    api.checkoutFailure = {
      type: 'StripeInvalidRequestError',
      rawType: 'invalid_request_error',
      statusCode: 400,
      param: 'expires_at',
      requestId: 'req_expired_checkout'
    };

    await expect(
      client.createSoloCheckout(checkoutRequest(client))
    ).rejects.toMatchObject({ code: 'STRIPE_CHECKOUT_REQUEST_REJECTED' });

    api.checkoutFailure = new Error('connection lost after dispatch');
    await expect(
      client.createSoloCheckout(checkoutRequest(client))
    ).rejects.toBeInstanceOf(StripeProviderFailure);
  });

  it('creates exactly one recurring Solo price with tax, ownership metadata and idempotency', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await expect(
      client.createSoloCheckout(checkoutRequest(client))
    ).resolves.toMatchObject({
      id: 'cs_solo_checkout',
      url: 'https://checkout.stripe.com/c/pay/cs_solo_checkout'
    });

    expect(api.checkoutCalls).toEqual([
      {
        parameters: {
          mode: 'subscription',
          line_items: [{ price: 'price_solo_monthly', quantity: 1 }],
          payment_method_types: ['card'],
          automatic_tax: { enabled: true },
          billing_address_collection: 'required',
          tax_id_collection: { enabled: true },
          client_reference_id: 'org_solo',
          expires_at: 1_794_312_000,
          customer_email: 'owner@example.com',
          metadata: {
            organisation_id: 'org_solo',
            initiating_user_id: 'user_owner',
            plan_code: 'SOLO_AU_2000',
            checkout_attempt_id: checkoutAttemptId,
            billing_cadence: 'MONTHLY'
          },
          subscription_data: {
            metadata: {
              organisation_id: 'org_solo',
              initiating_user_id: 'user_owner',
              plan_code: 'SOLO_AU_2000',
              checkout_attempt_id: checkoutAttemptId,
              billing_cadence: 'MONTHLY'
            }
          },
          success_url:
            'https://ap.motts.com.au/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
          cancel_url:
            'https://ap.motts.com.au/settings/billing?checkout=cancelled'
        },
        options: { idempotencyKey: 'solo-checkout:' + checkoutAttemptId }
      }
    ]);
  });

  it('never forwards a legacy trial deadline into paid Checkout', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);
    const legacyRequest = {
      ...checkoutRequest(client),
      trialEnd: 1_795_392_000
    };

    await client.createSoloCheckout(legacyRequest);

    expect(api.checkoutCalls[0]?.parameters.subscription_data).not.toHaveProperty(
      'trial_end'
    );
  });

  it('uses a stored Stripe customer instead of accepting caller-controlled customer details', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await client.createSoloCheckout({
      ...checkoutRequest(client),
      stripeCustomerId: 'cus_existing',
      customerEmail: 'ignored@example.com'
    });

    expect(api.checkoutCalls[0]?.parameters).toMatchObject({
      customer: 'cus_existing'
    });
    expect(api.checkoutCalls[0]?.parameters).not.toHaveProperty('customer_email');
  });

  it('uses only the configured annual Price and fails closed when it is unavailable', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);
    await client.createSoloCheckout(checkoutRequest(client, 'ANNUAL'));
    expect(api.checkoutCalls[0]?.parameters).toMatchObject({
      line_items: [{ price: 'price_solo_annual', quantity: 1 }],
      payment_method_types: ['card']
    });

    const unavailableApi = new FakeStripeApi();
    const unavailable = new StripeBillingClient(unavailableApi, {
      soloMonthlyPriceId: 'price_solo_monthly',
      priceCurrency: 'aud',
      automaticTaxEnabled: true,
      portalConfigurationId: 'bpc_solo',
      publicBaseUrl: 'https://ap.motts.com.au',
      webhookSecret: 'whsec_test_only'
    });
    expect(() => unavailable.checkoutConfiguration('ANNUAL')).toThrow(StripeConfigurationFailure);
    expect(unavailableApi.checkoutCalls).toEqual([]);
  });

  it('creates a request-only Stripe-hosted BECS setup and activates only the confirmed payment method', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await expect(
      client.createDirectDebitSetup({
        organisationId: 'org_solo',
        userId: 'platform_owner',
        stripeCustomerId: 'cus_solo',
        stripeSubscriptionId: 'sub_solo',
        directDebitRequestId: 'ddr_solo',
        setupAttemptVersion: 1,
        idempotencyKey: 'direct-debit-setup:org_solo:requested'
      })
    ).resolves.toEqual({
      id: 'cs_solo_checkout',
      url: 'https://checkout.stripe.com/c/pay/cs_solo_checkout',
      expiresAt: new Date('2026-11-10T12:00:00.000Z')
    });
    expect(api.checkoutCalls[0]).toEqual({
      parameters: {
        mode: 'setup',
        customer: 'cus_solo',
        currency: 'aud',
        payment_method_types: ['au_becs_debit'],
        client_reference_id: 'org_solo',
        metadata: {
          organisation_id: 'org_solo',
          initiating_user_id: 'platform_owner',
          stripe_subscription_id: 'sub_solo',
          direct_debit_request_id: 'ddr_solo',
          direct_debit_setup_version: '1',
          purpose: 'DIRECT_DEBIT_REQUEST'
        },
        setup_intent_data: {
          metadata: {
            organisation_id: 'org_solo',
            initiating_user_id: 'platform_owner',
              stripe_subscription_id: 'sub_solo',
              direct_debit_request_id: 'ddr_solo',
              direct_debit_setup_version: '1',
            purpose: 'DIRECT_DEBIT_REQUEST'
          }
        },
        success_url:
          'https://ap.motts.com.au/settings/billing?direct_debit=mandate_submitted&session_id={CHECKOUT_SESSION_ID}',
        cancel_url:
          'https://ap.motts.com.au/settings/billing?direct_debit=cancelled'
      },
      options: {
        idempotencyKey: 'direct-debit-setup:org_solo:requested'
      }
    });

    await expect(
      client.activateDirectDebit({
        stripeSubscriptionId: 'sub_solo',
        stripePaymentMethodId: 'pm_becs_confirmed',
        idempotencyKey: 'direct-debit-activate:org_solo:mandate_1'
      })
    ).resolves.toBeUndefined();
    expect(api.subscriptionUpdateCalls).toEqual([
      {
        subscriptionId: 'sub_solo',
        parameters: { default_payment_method: 'pm_becs_confirmed' },
        options: {
          idempotencyKey: 'direct-debit-activate:org_solo:mandate_1'
        }
      }
    ]);
    expect(JSON.stringify(api.checkoutCalls)).not.toMatch(
      /bank_account|account_number|bsb/i
    );
  });

  it.each([
    'http://ap.motts.com.au',
    'https://ap.motts.com.au/untrusted-path',
    'https://ap.motts.com.au?redirect=https://evil.example',
    'https://user:password@ap.motts.com.au'
  ])('rejects a public base URL that cannot safely anchor return URLs: %s', (url) => {
    const api = new FakeStripeApi();
    expect(
      () =>
        new StripeBillingClient(api, {
          soloMonthlyPriceId: 'price_solo_monthly',
          soloAnnualPriceId: 'price_solo_annual',
          priceCurrency: 'aud',
          automaticTaxEnabled: true,
          portalConfigurationId: 'bpc_solo',
          publicBaseUrl: url,
          webhookSecret: 'whsec_test_only'
        })
    ).toThrow(StripeConfigurationFailure);
  });
});

describe('StripeBillingClient portal', () => {
  it('creates a portal session only for a stored customer and a fixed return URL', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await expect(client.createBillingPortal('cus_existing')).resolves.toEqual({
      id: 'bps_solo_portal',
      url: 'https://billing.stripe.com/p/session/bps_solo_portal'
    });
    expect(api.portalCalls).toEqual([
      {
        customer: 'cus_existing',
        configuration: 'bpc_solo',
        return_url: 'https://ap.motts.com.au/settings/billing'
      }
    ]);
  });

  it('rejects a missing stored customer without calling Stripe', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await expect(client.createBillingPortal('')).rejects.toBeInstanceOf(
      StripeConfigurationFailure
    );
    expect(api.portalCalls).toEqual([]);
  });
});

describe('StripeBillingClient charge ownership', () => {
  it('resolves ownership through the charge payment intent and exactly one expanded invoice', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await expect(client.loadChargeOwnership('ch_invoice_payment')).resolves.toEqual({
      stripeCustomerId: 'cus_solo',
      stripeSubscriptionId: 'sub_solo'
    });
    expect(api.chargeCalls).toEqual(['ch_invoice_payment']);
    expect(api.invoicePaymentCalls).toEqual([
      {
        payment: {
          type: 'payment_intent',
          payment_intent: 'pi_invoice_payment'
        },
        expand: ['data.invoice'],
        limit: 2
      }
    ]);
  });

  it.each([
    [
      'a different returned charge ID',
      {
        id: 'ch_other',
        object: 'charge',
        customer: 'cus_solo',
        payment_intent: 'pi_1'
      }
    ],
    ['missing customer', { id: 'ch_1', object: 'charge', customer: null, payment_intent: 'pi_1' }],
    [
      'expanded customer',
      {
        id: 'ch_1',
        object: 'charge',
        customer: { id: 'cus_solo', object: 'customer' },
        payment_intent: 'pi_1'
      }
    ],
    ['missing payment intent', { id: 'ch_1', object: 'charge', customer: 'cus_solo', payment_intent: null }],
    [
      'expanded payment intent',
      {
        id: 'ch_1',
        object: 'charge',
        customer: 'cus_solo',
        payment_intent: { id: 'pi_1', object: 'payment_intent' }
      }
    ]
  ])('rejects a charge with %s', async (_label, chargeResponse) => {
    const api = new FakeStripeApi();
    api.chargeResponse = chargeResponse;

    await expect(
      createClient(api).loadChargeOwnership('ch_1')
    ).rejects.toBeInstanceOf(StripeProviderFailure);
    expect(api.invoicePaymentCalls).toEqual([]);
  });

  it.each([
    ['no matching invoice payment', { object: 'list', data: [], has_more: false, url: '/v1/invoice_payments' }],
    [
      'multiple matching invoice payments',
      {
        object: 'list',
        data: [
          { id: 'inpay_1', object: 'invoice_payment', invoice: 'in_1' },
          { id: 'inpay_2', object: 'invoice_payment', invoice: 'in_2' }
        ],
        has_more: false,
        url: '/v1/invoice_payments'
      }
    ],
    [
      'a paginated match',
      {
        object: 'list',
        data: [{ id: 'inpay_1', object: 'invoice_payment', invoice: 'in_1' }],
        has_more: true,
        url: '/v1/invoice_payments'
      }
    ],
    ['a malformed list', { object: 'list', data: 'not-an-array', has_more: false }]
  ])('rejects %s', async (_label, invoicePaymentResponse) => {
    const api = new FakeStripeApi();
    api.invoicePaymentResponse = invoicePaymentResponse;

    await expect(
      createClient(api).loadChargeOwnership('ch_invoice_payment')
    ).rejects.toBeInstanceOf(StripeProviderFailure);
  });

  it.each([
    ['an unexpanded invoice ID', 'in_solo'],
    [
      'a deleted invoice',
      { id: 'in_solo', object: 'invoice', deleted: true }
    ],
    [
      'a missing subscription parent',
      {
        id: 'in_solo',
        object: 'invoice',
        customer: 'cus_solo',
        parent: null
      }
    ],
    [
      'an expanded subscription identifier',
      {
        id: 'in_solo',
        object: 'invoice',
        customer: 'cus_solo',
        parent: {
          type: 'subscription_details',
          subscription_details: {
            subscription: { id: 'sub_solo', object: 'subscription' }
          }
        }
      }
    ],
    [
      'a customer mismatch',
      {
        id: 'in_solo',
        object: 'invoice',
        customer: 'cus_other',
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: 'sub_solo' }
        }
      }
    ]
  ])('rejects %s', async (_label, invoice) => {
    const api = new FakeStripeApi();
    api.invoicePaymentResponse = {
      object: 'list',
      data: [{ id: 'inpay_solo', object: 'invoice_payment', invoice }],
      has_more: false,
      url: '/v1/invoice_payments'
    };

    await expect(
      createClient(api).loadChargeOwnership('ch_invoice_payment')
    ).rejects.toBeInstanceOf(StripeProviderFailure);
  });

  it('does not accept metadata as subscription ownership evidence', async () => {
    const api = new FakeStripeApi();
    api.invoicePaymentResponse = {
      object: 'list',
      data: [
        {
          id: 'inpay_solo',
          object: 'invoice_payment',
          invoice: {
            id: 'in_solo',
            object: 'invoice',
            customer: 'cus_solo',
            metadata: { subscription: 'sub_attacker_controlled' },
            parent: null
          }
        }
      ],
      has_more: false,
      url: '/v1/invoice_payments'
    };

    await expect(
      createClient(api).loadChargeOwnership('ch_invoice_payment')
    ).rejects.toBeInstanceOf(StripeProviderFailure);
  });

  it.each([
    {
      type: 'payment_intent',
      payment_intent: 'pi_other'
    },
    {
      type: 'payment_intent',
      payment_intent: { id: 'pi_invoice_payment', object: 'payment_intent' }
    },
    {
      type: 'charge',
      charge: 'ch_invoice_payment'
    }
  ])('rejects invoice-payment evidence for another payment object: $type', async (payment) => {
    const api = new FakeStripeApi();
    api.invoicePaymentResponse = {
      object: 'list',
      data: [
        {
          id: 'inpay_solo',
          object: 'invoice_payment',
          payment,
          invoice: {
            id: 'in_solo',
            object: 'invoice',
            customer: 'cus_solo',
            parent: {
              type: 'subscription_details',
              subscription_details: { subscription: 'sub_solo' }
            }
          }
        }
      ],
      has_more: false,
      url: '/v1/invoice_payments'
    };

    await expect(
      createClient(api).loadChargeOwnership('ch_invoice_payment')
    ).rejects.toBeInstanceOf(StripeProviderFailure);
  });

  it.each(['charge', 'invoice payment'])(
    'maps a %s provider read failure to a non-sensitive provider error',
    async (operation) => {
      const api = new FakeStripeApi();
      if (operation === 'charge') {
        api.chargeFailure = new Error('secret upstream charge detail');
      } else {
        api.invoicePaymentFailure = new Error('secret upstream invoice detail');
      }

      let failure: unknown;
      try {
        await createClient(api).loadChargeOwnership('ch_invoice_payment');
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(StripeProviderFailure);
      expect((failure as Error).message).not.toContain('secret upstream');
    }
  );
});

describe('StripeBillingClient webhook verification', () => {
  it('passes the unparsed body, signature, secret and bounded tolerance to Stripe', () => {
    const api = new FakeStripeApi();
    const client = createClient(api);
    const rawBody = Buffer.from('{"id":"evt_subscription_updated"}');

    expect(client.verifyWebhook(rawBody, 't=1794201600,v1=signature')).toEqual({
      id: 'evt_subscription_updated',
      type: 'customer.subscription.updated',
      created: 1_794_201_600,
      data: { object: { id: 'sub_solo' } }
    });
    expect(api.webhookCalls).toEqual([
      {
        rawBody,
        signature: 't=1794201600,v1=signature',
        secret: 'whsec_test_only',
        tolerance: 300
      }
    ]);
  });

  it('rejects a missing signature before calling Stripe', () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    expect(() => client.verifyWebhook('{}', ' ')).toThrow(
      StripeWebhookSignatureFailure
    );
    expect(api.webhookCalls).toEqual([]);
  });

  it('maps invalid provider signatures to a non-sensitive failure', () => {
    const api = new FakeStripeApi();
    api.webhookFailure = new Error('provider details must not escape');
    const client = createClient(api);

    let failure: unknown;
    try {
      client.verifyWebhook('{}', 't=1794201600,v1=invalid');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(StripeWebhookSignatureFailure);
    expect((failure as Error).message).not.toContain('provider details');
  });
});

describe('paid Checkout attempts', () => {
  const attemptId = 'ee53e493-2de8-4bb2-bce6-8b0024c853a0';
  const metadata = {
    organisation_id: 'org_solo',
    initiating_user_id: 'user_owner',
    plan_code: 'SOLO_AU_2000',
    checkout_attempt_id: attemptId,
    billing_cadence: 'MONTHLY'
  };
  const request = {
    organisationId: 'org_solo',
    userId: 'user_owner',
    customerEmail: 'owner@example.com',
    billingCadence: 'MONTHLY' as const,
    attemptId,
    expiresAt: new Date(1_794_312_000 * 1000),
    priceId: 'price_solo_monthly',
    automaticTaxEnabled: true,
    publicOrigin: 'https://ap.motts.com.au',
    idempotencyKey: 'solo-checkout:' + attemptId
  };
  const sessionObject = {
    id: 'cs_solo_checkout',
    object: 'checkout.session',
    mode: 'subscription',
    status: 'open',
    metadata,
    client_reference_id: 'org_solo',
    customer: null,
    subscription: null,
    expires_at: 1_794_312_000,
    url: 'https://checkout.stripe.com/c/pay/cs_solo_checkout'
  };

  it('replays identical parameters, expiry and attempt metadata across configuration changes', async () => {
    const api = new FakeStripeApi();
    api.checkoutResponse = sessionObject;
    const changedConfiguration = new StripeBillingClient(api, {
      soloMonthlyPriceId: 'price_changed',
      priceCurrency: 'aud',
      automaticTaxEnabled: false,
      portalConfigurationId: 'bpc_solo',
      publicBaseUrl: 'https://new.example.com',
      webhookSecret: 'whsec_test_only'
    });
    await createClient(api).createSoloCheckout(request);
    await changedConfiguration.createSoloCheckout(request);
    expect(api.checkoutCalls[1]).toEqual(api.checkoutCalls[0]);
    expect(api.checkoutCalls[0]).toMatchObject({
      options: { idempotencyKey: 'solo-checkout:' + attemptId },
      parameters: {
        expires_at: 1_794_312_000,
        line_items: [{ price: 'price_solo_monthly', quantity: 1 }],
        automatic_tax: { enabled: true },
        metadata,
        subscription_data: { metadata }
      }
    });
  });

  it.each(['open', 'expired', 'complete'] as const)('retrieves and parses %s status without a provider mutation', async (status) => {
    const api = new FakeStripeApi();
    api.checkoutRetrieveResponse = {
      ...sessionObject,
      status,
      url: status === 'open' ? sessionObject.url : null,
      customer: status === 'complete' ? 'cus_solo' : null,
      subscription: status === 'complete' ? 'sub_solo' : null
    };
    await expect(createClient(api).retrieveSoloCheckout('cs_solo_checkout')).resolves.toMatchObject({
      status,
      attemptId,
      organisationId: 'org_solo',
      billingCadence: 'MONTHLY',
      expiresAt: new Date(1_794_312_000 * 1000),
      stripeCustomerId: status === 'complete' ? 'cus_solo' : null,
      stripeSubscriptionId: status === 'complete' ? 'sub_solo' : null
    });
    expect(api.checkoutRetrieveCalls).toEqual(['cs_solo_checkout']);
    expect(api.checkoutCalls).toEqual([]);
  });

  it.each([
    { id: 'cs_unexpected' },
    { status: 'unknown' },
    { metadata: { ...metadata, checkout_attempt_id: 'invalid' } },
    { client_reference_id: 'org_other' },
    { expires_at: null }
  ])('fails closed when provider Session identity or status is invalid', async (changes) => {
    const api = new FakeStripeApi();
    api.checkoutRetrieveResponse = { ...sessionObject, ...changes };
    await expect(createClient(api).retrieveSoloCheckout('cs_solo_checkout')).rejects.toBeInstanceOf(StripeProviderFailure);
  });
});
