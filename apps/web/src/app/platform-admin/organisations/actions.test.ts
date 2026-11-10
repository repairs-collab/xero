import { describe, expect, it, vi } from 'vitest';

import { createOrganisationAdminActions } from './actions.js';

describe('platform organisation actions', () => {
  it('uses the verified session actor and ignores submitted actor identities', async () => {
    const suspendOrganisation = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'organisation-1' }
    });
    const actions = createOrganisationAdminActions({
      getOwnerSession: async () => ({
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
});
