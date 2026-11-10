import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const createCognitoAuthorizationRequest = vi.hoisted(() =>
  vi.fn((_configuration: unknown, options: { returnTo: string; screenHint?: string }) => ({
    url: `https://auth.example.test/oauth2/authorize?screen_hint=${options.screenHint ?? ''}`,
    transaction: {
      state: 'state-1',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      expiresAt: '2026-11-09T01:10:00.000Z',
      returnTo: options.returnTo
    }
  }))
);

vi.mock('@bc5000/auth', () => ({
  createCognitoAuthorizationRequest,
  createCognitoTransactionCookie: () =>
    Promise.resolve('bc5000_login=transaction; Path=/auth; HttpOnly')
}));

vi.mock('../../../server/runtime.js', () => ({
  getCognitoConfiguration: () => ({ kind: 'cognito-configuration' }),
  getSessionSecret: () => new Uint8Array(32).fill(1)
}));

import { GET } from './route.js';

describe('Cognito login route', () => {
  it('opens hosted sign-up and returns a new customer to onboarding', async () => {
    const response = await GET(
      new NextRequest(
        'https://ap.motts.com.au/auth/login?mode=signup&returnTo=%2Fapprovals'
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://auth.example.test/oauth2/authorize?screen_hint=signup'
    );
    expect(createCognitoAuthorizationRequest).toHaveBeenCalledWith(
      { kind: 'cognito-configuration' },
      { returnTo: '/onboarding', screenHint: 'signup' }
    );
  });
});
