import { describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';

import { createUserAdministration } from './user-administration.js';

const session: AppSession = {
  userId: 'platform-owner',
  cognitoSubject: 'owner-subject',
  displayName: 'Platform Owner',
  expiresAt: '2026-12-01T00:00:00.000Z',
  memberships: []
};

describe('user administration authorization seam', () => {
  it('uses an injected authorizer before accessing customer data', async () => {
    const authorizer = vi.fn(() => {
      throw new Error('OWNER_CHECKED');
    });
    const service = createUserAdministration({
      database: {} as never,
      cognito: {
        createUser: vi.fn(),
        resendInvitation: vi.fn(),
        disableUser: vi.fn()
      },
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') },
      authorizer
    });

    await expect(
      service.listMembers(session, { organisationId: 'organisation-1' })
    ).rejects.toThrow('OWNER_CHECKED');
    expect(authorizer).toHaveBeenCalledWith(session, 'organisation-1');
  });

  it('uses a separate read authorizer so suspended administrators can inspect users', async () => {
    const authorizer = vi.fn(() => {
      throw new Error('MUTATION_CHECKED');
    });
    const reader = vi.fn(() => {
      throw new Error('READ_CHECKED');
    });
    const service = createUserAdministration({
      database: {} as never,
      cognito: {
        createUser: vi.fn(),
        resendInvitation: vi.fn(),
        disableUser: vi.fn()
      },
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') },
      authorizer,
      reader
    });

    await expect(
      service.listMembers(session, { organisationId: 'organisation-1' })
    ).rejects.toThrow('READ_CHECKED');
    expect(reader).toHaveBeenCalledWith(session, 'organisation-1');
    expect(authorizer).not.toHaveBeenCalled();
  });

  it('keeps tenant membership authorization as the default', async () => {
    const service = createUserAdministration({
      database: {} as never,
      cognito: {
        createUser: vi.fn(),
        resendInvitation: vi.fn(),
        disableUser: vi.fn()
      },
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    });

    await expect(
      service.listMembers(session, { organisationId: 'organisation-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
