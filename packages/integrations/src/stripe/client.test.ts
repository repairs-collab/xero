import { describe, expect, it } from 'vitest';

import {
  StripeBillingClient,
  StripeConfigurationFailure,
  StripeWebhookSignatureFailure,
  type StripeApi
} from './client.js';

class FakeStripeApi implements StripeApi {
  checkoutCalls: Array<{
    parameters: Record<string, unknown>;
    options: { idempotencyKey: string };
  }> = [];
  portalCalls: Array<Record<string, unknown>> = [];
  webhookCalls: Array<{
    rawBody: string | Buffer;
    signature: string;
    secret: string;
    tolerance: number;
  }> = [];
  webhookFailure: Error | undefined;

  checkout = {
    sessions: {
      create: (
        parameters: Record<string, unknown>,
        options: { idempotencyKey: string }
      ) => {
        this.checkoutCalls.push({ parameters, options });
        return Promise.resolve({
          id: 'cs_solo_checkout',
          url: 'https://checkout.stripe.com/c/pay/cs_solo_checkout'
        });
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
    soloPriceId: 'price_solo_au_2000',
    priceCurrency: 'aud',
    automaticTaxEnabled: true,
    portalConfigurationId: 'bpc_solo',
    publicBaseUrl: 'https://ap.motts.com.au',
    webhookSecret: 'whsec_test_only',
    webhookToleranceSeconds: 300
  });

describe('StripeBillingClient checkout', () => {
  it('creates exactly one recurring Solo price with tax, ownership metadata and idempotency', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await expect(
      client.createSoloCheckout({
        organisationId: 'org_solo',
        userId: 'user_owner',
        customerEmail: 'owner@example.com',
        idempotencyKey: 'solo-checkout:org_solo:attempt_1'
      })
    ).resolves.toEqual({
      id: 'cs_solo_checkout',
      url: 'https://checkout.stripe.com/c/pay/cs_solo_checkout'
    });

    expect(api.checkoutCalls).toEqual([
      {
        parameters: {
          mode: 'subscription',
          line_items: [{ price: 'price_solo_au_2000', quantity: 1 }],
          automatic_tax: { enabled: true },
          billing_address_collection: 'required',
          tax_id_collection: { enabled: true },
          client_reference_id: 'org_solo',
          customer_email: 'owner@example.com',
          metadata: {
            organisation_id: 'org_solo',
            initiating_user_id: 'user_owner',
            plan_code: 'SOLO_AU_2000'
          },
          subscription_data: {
            metadata: {
              organisation_id: 'org_solo',
              initiating_user_id: 'user_owner',
              plan_code: 'SOLO_AU_2000'
            }
          },
          success_url:
            'https://ap.motts.com.au/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
          cancel_url:
            'https://ap.motts.com.au/settings/billing?checkout=cancelled'
        },
        options: { idempotencyKey: 'solo-checkout:org_solo:attempt_1' }
      }
    ]);
  });

  it('passes the exact eligible local trial deadline to Stripe', async () => {
    const api = new FakeStripeApi();
    await createClient(api).createSoloCheckout({organisationId:'org_solo', userId:'user_owner', customerEmail:'owner@example.com', idempotencyKey:'trial', trialEnd:1795392000});
    expect(api.checkoutCalls[0]?.parameters.subscription_data).toMatchObject({trial_end:1795392000});
  });

  it('uses a stored Stripe customer instead of accepting caller-controlled customer details', async () => {
    const api = new FakeStripeApi();
    const client = createClient(api);

    await client.createSoloCheckout({
      organisationId: 'org_solo',
      userId: 'user_owner',
      stripeCustomerId: 'cus_existing',
      customerEmail: 'ignored@example.com',
      idempotencyKey: 'solo-checkout:org_solo:attempt_2'
    });

    expect(api.checkoutCalls[0]?.parameters).toMatchObject({
      customer: 'cus_existing'
    });
    expect(api.checkoutCalls[0]?.parameters).not.toHaveProperty('customer_email');
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
          soloPriceId: 'price_solo_au_2000',
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
