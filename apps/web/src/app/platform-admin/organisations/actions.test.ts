import { describe, expect, it, vi } from 'vitest';

import { createOrganisationAdminActions } from './actions.js';

describe('platform organisation actions', () => {
  it('uses the verified session actor and ignores submitted actor identities', async () => {
    const suspendOrganisation = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'organisation-1' }
    });
    const actions = createOrganisationAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { suspendOrganisation } as never,
      revalidate: vi.fn()
    });
    const form = new FormData();
    form.set('organisationId', 'organisation-1');
    form.set('reason', 'Owner review');
    form.set('expectedVersion', '2');
    form.set('actorUserId', 'attacker-controlled');

    await expect(actions.suspendOrganisationAction(form)).resolves.toEqual({
      ok: true,
      code: 'UPDATED'
    });
    expect(suspendOrganisation).toHaveBeenCalledWith('verified-owner', {
      organisationId: 'organisation-1',
      reason: 'Owner review',
      expectedVersion: 2
    });
  });

  it('preserves the financial-risk hold code for owner-page feedback', async () => {
    const reactivateOrganisation = vi.fn().mockResolvedValue({
      ok: false,
      code: 'BILLING_RISK_HOLD'
    });
    const revalidate = vi.fn();
    const actions = createOrganisationAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { reactivateOrganisation } as never,
      revalidate
    });
    const form = new FormData();
    form.set('organisationId', 'organisation-1');
    form.set('reason', 'Payment confirmed manually');
    form.set('expectedVersion', '4');

    await expect(actions.reactivateOrganisationAction(form)).resolves.toEqual({
      ok: false,
      code: 'BILLING_RISK_HOLD'
    });
    expect(revalidate).not.toHaveBeenCalled();
  });
});
