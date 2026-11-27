import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createCognitoAuthorizationRequest = vi.hoisted(() =>
  vi.fn((_configuration: unknown, options: { returnTo: string; mode?: 'signup' }) => ({
    url: `https://auth.example.test${options.mode === 'signup' ? '/signup' : '/oauth2/authorize'}`,
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
  getCognitoConfiguration: () => ({
    kind: 'cognito-configuration',
    redirectUri: 'https://ap.motts.com.au/auth/callback'
  }),
  getSessionSecret: () => new Uint8Array(32).fill(1)
}));

import { GET } from './route.js';

describe('Cognito login route', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns a direct signup request to the public start page while signup is closed', async () => {
    vi.stubEnv('ACCOUNT_PULSE_PUBLIC_SIGNUP_ENABLED', 'false');
    const response = await GET(new NextRequest('https://ap.motts.com.au/auth/login?mode=signup'));

    expect(response.headers.get('location')).toBe('https://ap.motts.com.au/start');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(createCognitoAuthorizationRequest).not.toHaveBeenCalled();
  });

  it('still opens ordinary sign-in while signup is closed', async () => {
    vi.stubEnv('ACCOUNT_PULSE_PUBLIC_SIGNUP_ENABLED', 'false');
    const response = await GET(new NextRequest('https://ap.motts.com.au/auth/login?returnTo=%2Fonboarding'));

    expect(response.headers.get('location')).toBe('https://auth.example.test/oauth2/authorize');
    expect(response.headers.get('set-cookie')).toContain('bc5000_login=transaction');
  });

  it('opens hosted sign-up and returns a new customer to onboarding', async () => {
    vi.stubEnv('ACCOUNT_PULSE_PUBLIC_SIGNUP_ENABLED', 'true');
    const response = await GET(
      new NextRequest(
        'https://ap.motts.com.au/auth/login?mode=signup&returnTo=%2Fapprovals'
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://auth.example.test/signup'
    );
    expect(createCognitoAuthorizationRequest).toHaveBeenCalledWith(
      { kind: 'cognito-configuration', redirectUri: 'https://ap.motts.com.au/auth/callback' },
      { returnTo: '/onboarding', mode: 'signup' }
    );
  });
});
