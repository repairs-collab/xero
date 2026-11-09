import { describe, expect, it } from 'vitest';

import {
  AuthenticationFailure,
  createSessionCookie,
  requireIdentitySession,
  requireSession
} from './session.js';

const secret = new Uint8Array(32).fill(7);
const issuedAt = new Date('2026-09-18T00:00:00.000Z');

describe('encrypted application sessions', () => {
  it('round-trips an encrypted HTTP-only eight-hour session', async () => {
    const cookie = await createSessionCookie(
      { cognitoSubject: 'subject-1' },
      { secret, now: issuedAt }
    );
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=28800');

    const session = await requireSession(
      new Request('https://bill-chaser.test/', {
        headers: { cookie: cookie.split(';')[0] ?? '' }
      }),
      {
        secret,
        now: new Date('2026-09-18T01:00:00.000Z'),
        memberships: {
          loadForSubject: () =>
            Promise.resolve({
              userId: 'user-1',
              displayName: 'Alex',
              active: true,
              memberships: [
                { organisationId: 'org-1', role: 'ADMIN', active: true }
              ]
            })
        }
      }
    );
    expect(session).toMatchObject({
      cognitoSubject: 'subject-1',
      userId: 'user-1',
      expiresAt: '2026-09-18T08:00:00.000Z'
    });
  });

  it('rejects an expired session before loading membership', async () => {
    const cookie = await createSessionCookie(
      { cognitoSubject: 'subject-1' },
      { secret, now: issuedAt }
    );
    let loads = 0;
    await expect(
      requireSession(
        new Request('https://bill-chaser.test/', {
          headers: { cookie: cookie.split(';')[0] ?? '' }
        }),
        {
          secret,
          now: new Date('2026-09-18T08:00:00.001Z'),
          memberships: {
            loadForSubject: () => {
              loads += 1;
              return Promise.reject(new Error('must not load'));
            }
          }
        }
      )
    ).rejects.toThrow(AuthenticationFailure);
    expect(loads).toBe(0);
  });

  it('rejects a subject with no active organisation membership', async () => {
    const cookie = await createSessionCookie(
      { cognitoSubject: 'subject-1' },
      { secret, now: issuedAt }
    );
    await expect(
      requireSession(
        new Request('https://bill-chaser.test/', {
          headers: { cookie: cookie.split(';')[0] ?? '' }
        }),
        {
          secret,
          now: new Date('2026-09-18T01:00:00.000Z'),
          memberships: {
            loadForSubject: () =>
              Promise.resolve({
                userId: 'user-1',
                displayName: 'Alex',
                active: true,
                memberships: []
              })
          }
        }
      )
    ).rejects.toThrow('UNAUTHENTICATED');
  });

  it('accepts an enabled identity before organisation provisioning', async () => {
    const cookie = await createSessionCookie(
      { cognitoSubject: 'subject-1' },
      { secret, now: issuedAt }
    );

    await expect(
      requireIdentitySession(
        new Request('https://bill-chaser.test/onboarding', {
          headers: { cookie: cookie.split(';')[0] ?? '' }
        }),
        {
          secret,
          now: new Date('2026-09-18T01:00:00.000Z'),
          memberships: {
            loadForSubject: () =>
              Promise.resolve({
                userId: 'user-1',
                displayName: 'Alex',
                active: true,
                memberships: []
              })
          }
        }
      )
    ).resolves.toMatchObject({
      userId: 'user-1',
      cognitoSubject: 'subject-1',
      memberships: []
    });
  });

  it('rejects a disabled identity before organisation provisioning', async () => {
    const cookie = await createSessionCookie(
      { cognitoSubject: 'subject-1' },
      { secret, now: issuedAt }
    );

    await expect(
      requireIdentitySession(
        new Request('https://bill-chaser.test/onboarding', {
          headers: { cookie: cookie.split(';')[0] ?? '' }
        }),
        {
          secret,
          now: new Date('2026-09-18T01:00:00.000Z'),
          memberships: {
            loadForSubject: () =>
              Promise.resolve({
                userId: 'user-1',
                displayName: 'Alex',
                active: false,
                memberships: []
              })
          }
        }
      )
    ).rejects.toThrow(AuthenticationFailure);
  });
});
