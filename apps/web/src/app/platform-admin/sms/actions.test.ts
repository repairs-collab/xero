import { describe, expect, it, vi } from 'vitest';

import { createSmsAdminActions } from './actions.js';

describe('platform SMS administration actions', () => {
  it('uses the verified owner identity and parses allowance limits', async () => {
    const updateSmsAllowance = vi.fn().mockResolvedValue({
      ok: true,
      value: { includedParts: 2_000, warningPercent: 80 }
    });
    const actions = createSmsAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { updateSmsAllowance } as never,
      revalidate: vi.fn()
    });
    const form = new FormData();
    form.set('organisationId', 'organisation-1');
    form.set('includedParts', '2000');
    form.set('warningPercent', '80');
    form.set('reason', 'Customer plan changed');
    form.set('actorUserId', 'untrusted-user');

    await expect(actions.updateSmsAllowanceAction(form)).resolves.toEqual({
      ok: true,
      code: 'UPDATED'
    });
    expect(updateSmsAllowance).toHaveBeenCalledWith('verified-owner', {
      organisationId: 'organisation-1',
      includedParts: 2_000,
      warningPercent: 80,
      reason: 'Customer plan changed'
    });
  });
});
