import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PlatformDirectDebitOperationsView } from './direct-debit-operations.js';

const snapshot = {
  organisationId: 'organisation-1',
  billingCadence: 'ANNUAL' as const,
  initialCardInvoiceId: 'in_initial_card',
  initialCardPaymentSucceededAt: new Date('2026-11-09T10:00:00.000Z'),
  legacyReconciliation: null,
  request: {
    id: 'direct-debit-request-1',
    organisationId: 'organisation-1',
    stripeSubscriptionId: 'sub_current',
    status: 'REQUESTED' as const,
    requestedAt: new Date('2026-11-09T11:00:00.000Z'),
    setupAttemptVersion: 0,
    setupSessionId: null,
    setupSessionExpiresAt: null,
    setupCheckoutCompletedAt: null,
    setupIntentId: null,
    stripePaymentMethodId: null,
    stripeMandateId: null,
    mandateConfirmedAt: null,
    activatedAt: null,
    requesterEmail: 'customer-admin@example.com'
  }
};

describe('platform direct-debit operations', () => {
  it('shows request and card evidence before offering manual link generation', () => {
    const html = renderToStaticMarkup(
      <PlatformDirectDebitOperationsView
        snapshot={snapshot}
        setupState={{ kind: 'IDLE' }}
        activationState={{ kind: 'IDLE' }}
        reconciliationState={{ kind: 'IDLE' }}
        createSetupLinkAction={vi.fn()}
        activateDirectDebitAction={vi.fn()}
        reconcileLegacyDirectDebitAction={vi.fn()}
      />
    );

    expect(html).toContain('customer-admin@example.com');
    expect(html).toContain('in_initial_card');
    expect(html).toContain('Generate customer setup link');
    expect(html).toContain('Do not open the link or enter bank details');
    expect(html).not.toContain('Activate direct debit');
  });

  it('shows provider-confirmed evidence before offering separate activation', () => {
    const html = renderToStaticMarkup(
      <PlatformDirectDebitOperationsView
        snapshot={{
          ...snapshot,
          request: {
            ...snapshot.request,
            status: 'MANDATE_CONFIRMED',
            setupAttemptVersion: 1,
            setupSessionId: 'cs_setup',
            setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
            setupCheckoutCompletedAt: new Date('2026-11-09T11:45:00.000Z'),
            setupIntentId: 'seti_becs',
            stripePaymentMethodId: 'pm_becs',
            stripeMandateId: 'mandate_becs',
            mandateConfirmedAt: new Date('2026-11-09T12:00:00.000Z')
          }
        }}
        setupState={{ kind: 'IDLE' }}
        activationState={{ kind: 'IDLE' }}
        reconciliationState={{ kind: 'IDLE' }}
        createSetupLinkAction={vi.fn()}
        activateDirectDebitAction={vi.fn()}
        reconcileLegacyDirectDebitAction={vi.fn()}
      />
    );

    expect(html).toContain('seti_becs');
    expect(html).toContain('mandate_becs');
    expect(html).toContain('Provider-confirmed mandate');
    expect(html).toContain('Activate direct debit');
    expect(html).not.toContain('Generate customer setup link');
  });

  it('renders a copyable customer-only link without redirecting the owner', () => {
    const html = renderToStaticMarkup(
      <PlatformDirectDebitOperationsView
        snapshot={snapshot}
        setupState={{
          kind: 'SETUP_LINK_CREATED',
          customerEmail: 'customer-admin@example.com',
          setupUrl: 'https://checkout.stripe.test/customer-becs-setup'
        }}
        activationState={{ kind: 'IDLE' }}
        reconciliationState={{ kind: 'IDLE' }}
        createSetupLinkAction={vi.fn()}
        activateDirectDebitAction={vi.fn()}
        reconcileLegacyDirectDebitAction={vi.fn()}
      />
    );

    expect(html).toContain('Deliver this link only to customer-admin@example.com');
    expect(html).toContain('readOnly=""');
    expect(html).toContain(
      'value="https://checkout.stripe.test/customer-becs-setup"'
    );
    expect(html).toContain('The platform owner must not complete this form');
  });

  it('requires a deliberate owner reconciliation before any new direct-debit action', () => {
    const html = renderToStaticMarkup(
      <PlatformDirectDebitOperationsView
        snapshot={{
          ...snapshot,
          request: null,
          legacyReconciliation: {
            id: 'legacy-request-1',
            organisationId: 'organisation-1',
            legacyStatus: 'ACTIVE',
            requestedAt: new Date('2026-10-01T10:00:00.000Z'),
            providerReconciledAt: null,
            providerReconciledByUserId: null,
            providerReconciliationOutcome: null,
            providerReconciliationReference: null
          }
        }}
        setupState={{ kind: 'IDLE' }}
        activationState={{ kind: 'IDLE' }}
        reconciliationState={{ kind: 'IDLE' }}
        createSetupLinkAction={vi.fn()}
        activateDirectDebitAction={vi.fn()}
        reconcileLegacyDirectDebitAction={vi.fn()}
      />
    );

    expect(html).toContain('Provider reconciliation required');
    expect(html).toContain('Legacy request ID');
    expect(html).toContain('legacy-request-1');
    expect(html).toContain('name="directDebitRequestId"');
    expect(html).toContain('name="reconciliationOutcome"');
    expect(html).toContain('name="providerReconciliationReference"');
    expect(html).toContain(
      'customer invoice default and source fallback'
    );
    expect(html).toContain('scheduled invoice retries');
    expect(html).toContain(
      'I inspected every effective Stripe collection path'
    );
    expect(html).not.toContain('Generate customer setup link');
    expect(html).not.toContain('Activate direct debit');
  });
});
