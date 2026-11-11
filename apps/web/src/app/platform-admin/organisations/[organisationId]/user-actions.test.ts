import { describe, expect, it, vi } from 'vitest';

import { createPlatformUserActions } from './user-actions.js';

describe('platform customer-user actions', () => {
  it('requires a reason and uses the verified owner identity', async () => {
    const disableMember = vi.fn().mockResolvedValue(undefined);
    const actions = createPlatformUserActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { disableMember } as never,
      revalidate: vi.fn()
    });
    const form = new FormData();
    form.set('organisationId', 'organisation-1');
    form.set('userId', 'user-1');
    form.set('expectedVersion', '3');
    form.set('reason', 'Customer confirmed departure');
    form.set('actorUserId', 'untrusted-user');

    await expect(actions.disableMemberAction(form)).resolves.toEqual({
      ok: true,
      code: 'UPDATED'
    });
    expect(disableMember).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'verified-owner' }),
      {
        organisationId: 'organisation-1',
        userId: 'user-1',
        expectedVersion: 3,
        reason: 'Customer confirmed departure'
      }
    );
  });
});
