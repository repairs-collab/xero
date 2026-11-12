import { describe, expect, it, vi } from 'vitest';

import { AuthorizationFailure } from '@bc5000/auth';

import { createPlatformCustomerProvisioningService } from './platform-customer-provisioning.js';

const session = {
  userId: 'owner-1',
  cognitoSubject: 'owner-subject',
  displayName: 'Platform Owner',
  expiresAt: '2026-11-12T00:00:00.000Z',
  memberships: []
};

const input = {
  name: 'Acme Repairs',
  adminEmail: 'Admin@Acme.example',
  adminDisplayName: 'Alex Admin',
  timeZone: 'Australia/Sydney' as const,
  baseCurrency: 'AUD' as const,
  includedSmsParts: 2_000,
  warningPercent: 80,
  reason: 'Approved beta customer'
};

describe('platform customer provisioning', () => {
  it('creates a safe workspace and invites its first administrator', async () => {
    const repository = {
      createWorkspace: vi.fn().mockResolvedValue({ organisationId: 'org-1' }),
      removeFailedWorkspace: vi.fn()
    };
    const inviteMember = vi.fn().mockResolvedValue({
      invitationId: 'invite-1',
      userId: 'user-1'
    });
    const service = createPlatformCustomerProvisioningService({
      verifyOwner: vi.fn().mockResolvedValue(true),
      repository,
      inviteMember,
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    });

    await expect(service.createCustomer(session, input)).resolves.toEqual({
      organisationId: 'org-1',
      invitationId: 'invite-1',
      userId: 'user-1'
    });
    expect(repository.createWorkspace).toHaveBeenCalledWith({
      actorUserId: 'owner-1',
      name: 'Acme Repairs',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      includedSmsParts: 2_000,
      warningPercent: 80,
      reason: 'Approved beta customer',
      now: new Date('2026-11-11T00:00:00.000Z')
    });
    expect(inviteMember).toHaveBeenCalledWith(session, {
      organisationId: 'org-1',
      email: 'admin@acme.example',
      displayName: 'Alex Admin',
      role: 'ADMIN',
      reason: 'Approved beta customer'
    });
    expect(repository.removeFailedWorkspace).not.toHaveBeenCalled();
  });

  it('removes the empty workspace when the Cognito invitation fails', async () => {
    const repository = {
      createWorkspace: vi.fn().mockResolvedValue({ organisationId: 'org-1' }),
      removeFailedWorkspace: vi.fn().mockResolvedValue(undefined)
    };
    const service = createPlatformCustomerProvisioningService({
      verifyOwner: vi.fn().mockResolvedValue(true),
      repository,
      inviteMember: vi.fn().mockRejectedValue(new Error('EMAIL_FAILED')),
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    });

    await expect(service.createCustomer(session, input)).rejects.toThrow(
      'EMAIL_FAILED'
    );
    expect(repository.removeFailedWorkspace).toHaveBeenCalledWith('org-1');
  });

  it('rejects non-owners and invalid customer details', async () => {
    const dependencies = {
      verifyOwner: vi.fn().mockResolvedValue(false),
      repository: {
        createWorkspace: vi.fn(),
        removeFailedWorkspace: vi.fn()
      },
      inviteMember: vi.fn(),
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    };
    const service = createPlatformCustomerProvisioningService(dependencies);
    await expect(service.createCustomer(session, input)).rejects.toBeInstanceOf(
      AuthorizationFailure
    );

    dependencies.verifyOwner.mockResolvedValue(true);
    await expect(
      service.createCustomer(session, { ...input, adminEmail: 'invalid' })
    ).rejects.toThrow('VALIDATION');
    expect(dependencies.repository.createWorkspace).not.toHaveBeenCalled();
  });

  it('rejects New Zealand provisioning while the commercial release is Australia-only', async () => {
    const dependencies = {
      verifyOwner: vi.fn().mockResolvedValue(true),
      repository: {
        createWorkspace: vi.fn(),
        removeFailedWorkspace: vi.fn()
      },
      inviteMember: vi.fn(),
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    };
    const service = createPlatformCustomerProvisioningService(dependencies);

    await expect(
      service.createCustomer(session, {
        ...input,
        timeZone: 'Pacific/Auckland' as never,
        baseCurrency: 'NZD' as never
      })
    ).rejects.toThrow('VALIDATION');
    expect(dependencies.repository.createWorkspace).not.toHaveBeenCalled();
  });
});
