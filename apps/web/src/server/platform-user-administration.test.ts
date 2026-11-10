import { describe, expect, it, vi } from 'vitest';

import type { AppSession, Role } from '@bc5000/auth';

import type {
  UserAdministrationAtomicAudit,
  UserAdministrationMutationAudit
} from '../app/(protected)/settings/users/user-administration.js';

import { createPlatformUserAdministration } from './platform-user-administration.js';

const ownerSession: AppSession = {
  userId: 'owner-user',
  cognitoSubject: 'owner-subject',
  displayName: 'Owner',
  expiresAt: '2026-12-01T00:00:00.000Z',
  memberships: []
};

type AtomicInput = { atomicAudit?: UserAdministrationAtomicAudit };
type InviteInput = AtomicInput & { role: Role };
type InvitationInput = AtomicInput & { invitationId: string };
type MembershipInput = AtomicInput & { userId: string; role?: Role };

const setup = (owner = true) => {
  const auditValues: unknown[] = [];
  const transaction = {
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        auditValues.push(value);
        return Promise.resolve();
      })
    }))
  };
  const invokeAudit = async (
    input: AtomicInput,
    audit: UserAdministrationMutationAudit
  ) => input.atomicAudit?.(transaction as never, audit);
  const shared = {
    listMembers: vi.fn().mockResolvedValue([]),
    inviteMember: vi.fn(async (_session: AppSession, input: InviteInput) => {
      await invokeAudit(input, {
        eventType: 'USER_INVITED', entityType: 'USER', entityId: 'user-1', beforeValue: null, afterValue: { role: input.role }
      });
      return { invitationId: 'invitation-1', userId: 'user-1' };
    }),
    resendInvitation: vi.fn(async (_session: AppSession, input: InvitationInput) => invokeAudit(input, {
      eventType: 'USER_INVITATION_RESENT', entityType: 'INVITATION', entityId: input.invitationId, beforeValue: null, afterValue: null
    })),
    changeRole: vi.fn(async (_session: AppSession, input: MembershipInput) => invokeAudit(input, {
      eventType: 'USER_ROLE_CHANGED', entityType: 'MEMBERSHIP', entityId: input.userId, beforeValue: null, afterValue: { role: input.role }
    })),
    disableMember: vi.fn(async (_session: AppSession, input: MembershipInput) => invokeAudit(input, {
      eventType: 'USER_DISABLED', entityType: 'MEMBERSHIP', entityId: input.userId, beforeValue: null, afterValue: { active: false }
    }))
  };
  return {
    shared,
    auditValues,
    service: createPlatformUserAdministration({
      verifyOwner: vi.fn().mockResolvedValue(owner),
      shared,
      database: transaction as never,
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    })
  };
};

describe('platform customer-user administration', () => {
  it('lets a current owner without customer membership delegate every guarded mutation and audits reasons', async () => {
    const { service, shared, auditValues } = setup();

    await service.inviteMember(ownerSession, {
      organisationId: 'organisation-1',
      email: 'new@example.com',
      displayName: 'New User',
      role: 'OPERATOR',
      reason: 'Customer requested access'
    });
    await service.resendInvitation(ownerSession, {
      organisationId: 'organisation-1',
      invitationId: 'invitation-1',
      expectedVersion: 0,
      reason: 'Customer did not receive it'
    });
    await service.changeRole(ownerSession, {
      organisationId: 'organisation-1',
      userId: 'user-1',
      role: 'ADMIN',
      expectedVersion: 0,
      reason: 'Promoted by customer owner'
    });
    await service.disableMember(ownerSession, {
      organisationId: 'organisation-1',
      userId: 'user-1',
      expectedVersion: 1,
      reason: 'User left the customer business'
    });

    expect(shared.inviteMember).toHaveBeenCalledWith(ownerSession, expect.objectContaining({
      organisationId: 'organisation-1',
      email: 'new@example.com',
      displayName: 'New User',
      role: 'OPERATOR'
    }));
    expect(auditValues).toHaveLength(4);
    expect(auditValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'PLATFORM_USER_INVITED',
          reason: 'Customer requested access'
        }),
        expect.objectContaining({
          eventType: 'PLATFORM_USER_DISABLED',
          reason: 'User left the customer business'
        })
      ])
    );
  });

  it('rejects an ordinary customer admin before calling the shared service', async () => {
    const { service, shared } = setup(false);

    await expect(
      service.disableMember(ownerSession, {
        organisationId: 'organisation-1',
        userId: 'user-1',
        expectedVersion: 0,
        reason: 'Not authorised'
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(shared.disableMember).not.toHaveBeenCalled();
  });

  it('preserves shared last-admin failures and writes no platform success audit', async () => {
    const { service, shared, auditValues } = setup();
    shared.disableMember.mockRejectedValueOnce(new Error('LAST_ADMIN_REQUIRED'));

    await expect(
      service.disableMember(ownerSession, {
        organisationId: 'organisation-1',
        userId: 'last-admin',
        expectedVersion: 0,
        reason: 'Attempted removal'
      })
    ).rejects.toThrow('LAST_ADMIN_REQUIRED');
    expect(auditValues).toHaveLength(0);
  });
});
