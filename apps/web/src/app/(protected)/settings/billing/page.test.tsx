import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBillingAccountSnapshot = vi.hoisted(() => vi.fn());
const loadAllowance = vi.hoisted(() => vi.fn());
const loadUsage = vi.hoisted(() => vi.fn());
const requireWebSession = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers())
}));

vi.mock('../../../../server/runtime.js', () => ({
  getBillingAccountSnapshot,
  getSmsCommerceRepository: () => ({ loadAllowance, loadUsage }),
  isStripeBillingConfigured: () => true,
  requireWebSession
}));

vi.mock('./actions.js', () => ({
  openBillingPortal: vi.fn(),
  requestDirectDebit: vi.fn(),
  startSoloCheckout: vi.fn()
}));

import BillingSettingsPage from './page.js';

describe('billing SMS hard-cap copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWebSession.mockResolvedValue({
      userId: 'user-admin',
      memberships: [
        {
          organisationId: 'org-solo',
          role: 'ADMIN',
          active: true,
          organisationStatus: 'ACTIVE'
        }
      ]
    });
    getBillingAccountSnapshot.mockResolvedValue({
      organisationId: 'org-solo',
      billingEmail: 'admin@example.com',
      edition: 'SOLO',
      planCode: 'SOLO_AU_2000',
      billingCadence: 'MONTHLY',
      status: 'ACTIVE',
      stripeProviderStatus: 'active',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
      trialEndsAt: null,
      cancelAt: null,
      cancelledAt: null,
      lastStripeEventCreatedAt: new Date('2026-11-01T00:00:00.000Z'),
      initialCardInvoiceId: null,
      initialCardPaymentSucceededAt: null,
      directDebitStatus: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z')
    });
    loadUsage.mockResolvedValue({
      billingPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
      billingPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
      includedParts: 2_500,
      warningPercent: 80,
      committedParts: 1_234,
      reservedParts: 6,
      remainingParts: 1_260
    });
    loadAllowance.mockResolvedValue({
      includedParts: 2_500,
      warningPercent: 80
    });
  });

  it('renders configured included, used and remaining parts with an explicit blocked limit', async () => {
    const markup = renderToStaticMarkup(await BillingSettingsPage({}));

    expect(markup).toContain('2,500 SMS parts per monthly allowance period');
    expect(markup).toContain('1,240 of 2,500 parts used');
    expect(markup).toContain('Used this monthly allowance period');
    expect(markup).toContain('Remaining this monthly allowance period');
    expect(markup).toContain('1,260');
    expect(markup).toContain(
      'Sends that would exceed the included allowance are blocked'
    );
    expect(markup).toContain('Blocked sends are not automatically replayed');
    expect(markup).not.toMatch(/overage/i);
  });

  it('shows a recoverable conflict when another Checkout is still being resolved', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      ...(await getBillingAccountSnapshot()),
      status: 'INCOMPLETE',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null
    });
    const markup = renderToStaticMarkup(await BillingSettingsPage({
      searchParams: Promise.resolve({
        checkout: 'attempt-conflict',
        checkoutCadence: 'MONTHLY'
      })
    }));

    expect(markup).toContain('A Stripe checkout is already in progress');
    expect(markup).toContain('Monthly checkout is already in progress');
    expect(markup).toContain('Reopen monthly checkout');
    expect(markup).toContain('Annual unavailable while monthly checkout is in progress');
  });

  it('renders exact monthly and derived annual AUD pricing before paid signup', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      ...(await getBillingAccountSnapshot()),
      status: 'INCOMPLETE',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null
    });

    const markup = renderToStaticMarkup(await BillingSettingsPage({}));

    expect(markup).toContain('$299.00 AUD excluding GST');
    expect(markup).toContain('GST $29.90');
    expect(markup).toContain('payable total $328.90');
    expect(markup).toContain('$3,408.60 AUD excluding GST');
    expect(markup).toContain('GST $340.86');
    expect(markup).toContain('payable total $3,749.46');
    expect(markup).toContain('5% less than twelve monthly charges');
    expect(markup).toContain('2,000 included SMS parts reset every month');
    expect(markup).toMatch(/name="billingCadence" value="MONTHLY"/);
    expect(markup).toMatch(/name="billingCadence" value="ANNUAL"/);
    expect(markup).toContain('First payment is collected by card on signup');
    expect(markup).not.toContain('Request direct debit');
  });

  it('offers only a request after first-card evidence and never collects bank details', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      ...(await getBillingAccountSnapshot()),
      initialCardInvoiceId: 'in_initial_card',
      initialCardPaymentSucceededAt: new Date('2026-11-01T00:00:00.000Z'),
      directDebitStatus: null
    });

    const markup = renderToStaticMarkup(await BillingSettingsPage({}));

    expect(markup).toContain('Request direct debit');
    expect(markup).toContain('reviewed manually');
    expect(markup).toContain('Stripe-hosted setup link');
    expect(markup).toContain('not enabled automatically');
    expect(markup).not.toMatch(/name="(?:bsb|accountNumber|bankAccount)"/i);
  });

  it('surfaces legacy provider reconciliation without exposing legacy payment evidence', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      ...(await getBillingAccountSnapshot()),
      initialCardInvoiceId: null,
      initialCardPaymentSucceededAt: null,
      directDebitStatus: 'RECONCILIATION_REQUIRED'
    });

    const markup = renderToStaticMarkup(await BillingSettingsPage({}));

    expect(markup).toContain('Reconciliation required');
    expect(markup).toContain(
      'A previous direct-debit record needs review before another request can be made. Contact support.'
    );
    expect(markup).not.toContain('Request direct debit');
    expect(markup).not.toMatch(/(?:mandate|payment method)_[a-z0-9]/i);
  });

  it('uses the configured trial allowance before Stripe supplies a billing period', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      organisationId: 'org-solo',
      billingEmail: 'admin@example.com',
      edition: 'SOLO',
      planCode: 'SOLO_AU_2000',
      billingCadence: 'MONTHLY',
      status: 'TRIALING',
      stripeProviderStatus: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: new Date('2026-11-30T00:00:00.000Z'),
      cancelAt: null,
      cancelledAt: null,
      lastStripeEventCreatedAt: null,
      initialCardInvoiceId: null,
      initialCardPaymentSucceededAt: null,
      directDebitStatus: null,
      createdAt: new Date('2026-11-01T00:00:00.000Z')
    });
    loadUsage.mockResolvedValue(null);
    loadAllowance.mockResolvedValue({
      includedParts: 2_500,
      warningPercent: 80
    });

    const markup = renderToStaticMarkup(await BillingSettingsPage({}));

    expect(markup).toContain('2,500 SMS parts per monthly allowance period');
    expect(markup).toContain('0 of 2,500 parts used');
    expect(markup).toContain('Remaining this monthly allowance period');
    expect(markup).toContain('2,500');
  });

  it('shows the internal legacy SMS exemption instead of a Solo hard allowance', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      organisationId: 'org-solo',
      billingEmail: 'admin@example.com',
      edition: 'INTERNAL_LEGACY',
      planCode: 'INTERNAL_LEGACY',
      billingCadence: 'MONTHLY',
      status: 'ACTIVE',
      stripeProviderStatus: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
      trialEndsAt: null,
      cancelAt: null,
      cancelledAt: null,
      lastStripeEventCreatedAt: null,
      initialCardInvoiceId: null,
      initialCardPaymentSucceededAt: null,
      directDebitStatus: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z')
    });

    const markup = renderToStaticMarkup(await BillingSettingsPage({}));

    expect(markup).toContain('Internal legacy account');
    expect(markup).toContain('Allowance exempt');
    expect(markup).toContain(
      'This internal legacy account is not subject to the Solo SMS allowance'
    );
    expect(markup).not.toContain('Hard allowance');
    expect(markup).not.toContain(
      'Sends that would exceed the included allowance are blocked'
    );
  });
});
