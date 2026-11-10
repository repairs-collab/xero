import { describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';

import { createPlatformAuthorizer } from './platform-authorization.js';

const session = (memberships: AppSession['memberships'] = []): AppSession => ({
  userId: 'owner-user',
  cognitoSubject: 'owner-subject',
  displayName: 'AccountPulse Owner',
  expiresAt: '2026-12-01T00:00:00.000Z',
  memberships
});

describe('platform authorization', () => {
  it('allows an active database owner without an organisation membership', async () => {
    const authorizer = createPlatformAuthorizer({
      requireIdentitySession: () => Promise.resolve(session()),
      loadActivePlatformRole: () => Promise.resolve('OWNER')
    });

    await expect(
      authorizer.requirePlatformOwner(new Request('https://ap.motts.com.au/platform-admin'))
    ).resolves.toEqual(session());
  });

  it('does not grant platform access to an ordinary customer administrator', async () => {
    const authorizer = createPlatformAuthorizer({
      requireIdentitySession: () =>
        Promise.resolve(session([{ organisationId: 'customer-1', role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }])),
      loadActivePlatformRole: () => Promise.resolve(null)
    });

    await expect(
      authorizer.requirePlatformOwner(new Request('https://ap.motts.com.au/platform-admin'))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies a disabled owner when the active-role lookup returns no role', async () => {
    const authorizer = createPlatformAuthorizer({
      requireIdentitySession: () => Promise.resolve(session()),
      loadActivePlatformRole: () => Promise.resolve(null)
    });

    await expect(authorizer.isPlatformOwner('owner-user')).resolves.toBe(false);
  });

  it('allows an owner even when their only customer membership is inactive', async () => {
    const ownerSession = session([
      {
        organisationId: 'suspended-customer',
        role: 'ADMIN',
        active: false,
        organisationStatus: 'ACTIVE'
      }
    ]);
    const authorizer = createPlatformAuthorizer({
      requireIdentitySession: () => Promise.resolve(ownerSession),
      loadActivePlatformRole: () => Promise.resolve('OWNER')
    });

    await expect(
      authorizer.requirePlatformOwner(new Request('https://ap.motts.com.au/platform-admin'))
    ).resolves.toEqual(ownerSession);
  });

  it('observes role revocation on the next request instead of trusting the session', async () => {
    let role: 'OWNER' | null = 'OWNER';
    const authorizer = createPlatformAuthorizer({
      requireIdentitySession: () => Promise.resolve(session()),
      loadActivePlatformRole: () => Promise.resolve(role)
    });
    const request = new Request('https://ap.motts.com.au/platform-admin');

    await expect(authorizer.requirePlatformOwner(request)).resolves.toBeDefined();
    role = null;
    await expect(authorizer.requirePlatformOwner(request)).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
  });
});
