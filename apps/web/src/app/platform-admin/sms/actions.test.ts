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
      expectedUpdatedAt: null,
      reason: 'Customer plan changed'
    });
  });

  it('uses the verified owner identity for pool verification and ignores a forged actor', async () => {
    const verifySmsNumberForPool = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'number-1' }
    });
    const revalidate = vi.fn();
    const actions = createSmsAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { verifySmsNumberForPool } as never,
      revalidate
    });
    const form = new FormData();
    form.set('numberId', 'number-1');
    form.set('expectedUpdatedAt', '2026-11-10T00:00:00.000Z');
    form.set('providerNumberId', 'sinch-number-1');
    form.set('reason', 'Ownership and messaging verified');
    form.set('verificationConfirmed', 'on');
    form.set('actorUserId', 'untrusted-user');

    await expect(actions.verifySmsNumberForPoolAction(form)).resolves.toEqual({
      ok: true,
      code: 'UPDATED'
    });
    expect(verifySmsNumberForPool).toHaveBeenCalledWith('verified-owner', {
      numberId: 'number-1',
      expectedUpdatedAt: new Date('2026-11-10T00:00:00.000Z'),
      providerNumberId: 'sinch-number-1',
      reason: 'Ownership and messaging verified',
      verificationConfirmed: true
    });
    expect(revalidate).toHaveBeenCalledWith('/platform-admin/sms');
  });
});
