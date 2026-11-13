import { describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';

import { createPlatformDirectDebitActions } from './direct-debit-actions.js';

const ownerSession: AppSession = {
  userId: 'verified-owner',
  cognitoSubject: 'owner-subject',
  displayName: 'Platform Owner',
  expiresAt: '2026-12-01T00:00:00.000Z',
  memberships: []
};

const form = (organisationId = 'organisation-1') => {
  const data = new FormData();
  data.set('organisationId', organisationId);
  data.set('confirmation', 'confirmed');
  data.set('actorUserId', 'forged-actor');
  return data;
};

const reconciliationForm = (organisationId = 'organisation-1') => {
  const data = form(organisationId);
  data.set('reconciliationOutcome', 'LEGACY_DEFAULT_REMOVED');
  return data;
};

describe('platform direct-debit owner actions', () => {
  it('returns a customer-delivery setup link without redirecting the owner', async () => {
    const createDirectDebitSetup = vi.fn().mockResolvedValue({
      id: 'cs_becs_setup',
      url: 'https://checkout.stripe.test/customer-becs-setup',
      deliveryMode: 'MANUAL_CUSTOMER_DELIVERY',
      customerEmail: 'customer-admin@example.com'
    });
    const revalidate = vi.fn();
    const actions = createPlatformDirectDebitActions({
      getOwnerSession: () => Promise.resolve(ownerSession),
      getService: () =>
        Promise.resolve({ createDirectDebitSetup } as never),
      revalidate
    });

    await expect(
      actions.createSetupLinkAction({ kind: 'IDLE' }, form())
    ).resolves.toEqual({
      kind: 'SETUP_LINK_CREATED',
      customerEmail: 'customer-admin@example.com',
      setupUrl: 'https://checkout.stripe.test/customer-becs-setup'
    });
    expect(createDirectDebitSetup).toHaveBeenCalledWith(
      ownerSession,
      'organisation-1'
    );
    expect(revalidate).toHaveBeenCalledWith(
      '/platform-admin/organisations/organisation-1'
    );
  });

  it('uses the verified owner session and preserves the selected tenant for activation', async () => {
    const activateDirectDebit = vi.fn().mockResolvedValue({ status: 'ACTIVE' });
    const actions = createPlatformDirectDebitActions({
      getOwnerSession: () => Promise.resolve(ownerSession),
      getService: () => Promise.resolve({ activateDirectDebit } as never),
      revalidate: vi.fn()
    });

    await expect(
      actions.activateDirectDebitAction(
        { kind: 'IDLE' },
        form('organisation-target')
      )
    ).resolves.toEqual({ kind: 'ACTIVATED' });
    expect(activateDirectDebit).toHaveBeenCalledWith(
      ownerSession,
      'organisation-target'
    );
  });

  it('fails closed before service access when owner authentication is absent', async () => {
    const getService = vi.fn();
    const actions = createPlatformDirectDebitActions({
      getOwnerSession: () => Promise.reject(new Error('FORBIDDEN')),
      getService,
      revalidate: vi.fn()
    });

    await expect(
      actions.createSetupLinkAction({ kind: 'IDLE' }, form())
    ).resolves.toEqual({ kind: 'FAILED' });
    expect(getService).not.toHaveBeenCalled();
  });

  it('records reconciliation only through the verified owner session', async () => {
    const reconcileLegacyDirectDebit = vi.fn().mockResolvedValue(undefined);
    const revalidate = vi.fn();
    const actions = createPlatformDirectDebitActions({
      getOwnerSession: () => Promise.resolve(ownerSession),
      getService: () =>
        Promise.resolve({ reconcileLegacyDirectDebit } as never),
      revalidate
    });

    await expect(
      actions.reconcileLegacyAction(
        { kind: 'IDLE' },
        reconciliationForm('organisation-target')
      )
    ).resolves.toEqual({ kind: 'RECONCILED' });
    expect(reconcileLegacyDirectDebit).toHaveBeenCalledWith(
      ownerSession,
      'organisation-target',
      'LEGACY_DEFAULT_REMOVED'
    );
    expect(revalidate).toHaveBeenCalledWith(
      '/platform-admin/organisations/organisation-target'
    );
  });
});
