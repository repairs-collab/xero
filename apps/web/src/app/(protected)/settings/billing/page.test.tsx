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
    const markup = renderToStaticMarkup(await BillingSettingsPage());

    expect(markup).toContain('2,500 SMS parts per billing period');
    expect(markup).toContain('1,240 of 2,500 parts used');
    expect(markup).toContain('Used this billing period');
    expect(markup).toContain('Remaining this billing period');
    expect(markup).toContain('1,260');
    expect(markup).toContain(
      'Sends that would exceed the included allowance are blocked'
    );
    expect(markup).toContain('Blocked sends are not automatically replayed');
    expect(markup).not.toMatch(/overage/i);
  });

  it('uses the configured trial allowance before Stripe supplies a billing period', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      organisationId: 'org-solo',
      billingEmail: 'admin@example.com',
      edition: 'SOLO',
      planCode: 'SOLO_AU_2000',
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
      createdAt: new Date('2026-11-01T00:00:00.000Z')
    });
    loadUsage.mockResolvedValue(null);
    loadAllowance.mockResolvedValue({
      includedParts: 2_500,
      warningPercent: 80
    });

    const markup = renderToStaticMarkup(await BillingSettingsPage());

    expect(markup).toContain('2,500 SMS parts per billing period');
    expect(markup).toContain('0 of 2,500 parts used');
    expect(markup).toContain('Remaining this billing period');
    expect(markup).toContain('2,500');
  });

  it('shows the internal legacy SMS exemption instead of a Solo hard allowance', async () => {
    getBillingAccountSnapshot.mockResolvedValue({
      organisationId: 'org-solo',
      billingEmail: 'admin@example.com',
      edition: 'INTERNAL_LEGACY',
      planCode: 'INTERNAL_LEGACY',
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
      createdAt: new Date('2026-10-01T00:00:00.000Z')
    });

    const markup = renderToStaticMarkup(await BillingSettingsPage());

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
