import { afterEach, describe, expect, it } from 'vitest';

import {
  getStripeConfiguration,
  getXeroOAuthConfiguration,
  getXeroTokenCipher
} from './runtime.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe.sequential('Stripe web runtime configuration', () => {
  it('requires every billing value and accepts only the public HTTPS origin', () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SOLO_MONTHLY_PRICE_ID;
    delete process.env.STRIPE_SOLO_ANNUAL_PRICE_ID;
    delete process.env.STRIPE_SMS_OVERAGE_PRICE_ID;
    delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    delete process.env.PUBLIC_BASE_URL;

    expect(() => getStripeConfiguration()).toThrow(
      'Stripe billing configuration is incomplete'
    );

    process.env.STRIPE_SECRET_KEY = 'sk_test_accountpulse';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_accountpulse';
    process.env.STRIPE_SOLO_MONTHLY_PRICE_ID = 'price_solo_monthly';
    process.env.STRIPE_SOLO_ANNUAL_PRICE_ID = 'price_solo_annual';
    process.env.STRIPE_SMS_OVERAGE_PRICE_ID = 'price_solo_sms_overage';
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_solo';
    process.env.PUBLIC_BASE_URL = 'http://ap.motts.com.au';
    expect(() => getStripeConfiguration()).toThrow(
      'PUBLIC_BASE_URL must be an HTTPS origin'
    );

    process.env.PUBLIC_BASE_URL = 'https://ap.motts.com.au';
    expect(getStripeConfiguration()).toEqual({
      secretKey: 'sk_test_accountpulse',
      webhookSecret: 'whsec_accountpulse',
      soloMonthlyPriceId: 'price_solo_monthly',
      soloAnnualPriceId: 'price_solo_annual',
      soloSmsOveragePriceId: 'price_solo_sms_overage',
      portalConfigurationId: 'bpc_solo',
      publicBaseUrl: 'https://ap.motts.com.au',
      priceCurrency: 'aud',
      automaticTaxEnabled: true,
      webhookToleranceSeconds: 300
    });

    process.env.STRIPE_SOLO_ANNUAL_PRICE_ID = 'price_solo_monthly';
    expect(() => getStripeConfiguration()).toThrow(
      'Stripe billing Price IDs must be distinct'
    );
  });
});

describe.sequential('Xero web runtime configuration', () => {
  it('requires every customer OAuth value and returns no defaults', () => {
    delete process.env.XERO_OAUTH_CLIENT_ID;
    delete process.env.XERO_OAUTH_CLIENT_SECRET;
    delete process.env.XERO_OAUTH_REDIRECT_URI;

    expect(() => getXeroOAuthConfiguration()).toThrow(
      'Xero OAuth configuration is incomplete'
    );

    process.env.XERO_OAUTH_CLIENT_ID = 'client-id';
    process.env.XERO_OAUTH_CLIENT_SECRET = 'client-secret';
    process.env.XERO_OAUTH_REDIRECT_URI =
      'https://ap.motts.com.au/xero/callback';
    expect(getXeroOAuthConfiguration()).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://ap.motts.com.au/xero/callback'
    });
  });

  it('builds the refresh-token cipher only from a complete key ring', () => {
    delete process.env.XERO_TOKEN_ENCRYPTION_KEYS_JSON;
    delete process.env.XERO_TOKEN_ACTIVE_KEY_ID;
    expect(() => getXeroTokenCipher()).toThrow(
      'Xero token encryption configuration is incomplete'
    );

    process.env.XERO_TOKEN_ENCRYPTION_KEYS_JSON = JSON.stringify({
      primary: Buffer.alloc(32, 7).toString('base64')
    });
    process.env.XERO_TOKEN_ACTIVE_KEY_ID = 'primary';
    const cipher = getXeroTokenCipher();
    const encrypted = cipher.encrypt('rotating-refresh-token');
    expect(encrypted.keyId).toBe('primary');
    expect(cipher.decrypt(encrypted)).toBe('rotating-refresh-token');
  });
});
