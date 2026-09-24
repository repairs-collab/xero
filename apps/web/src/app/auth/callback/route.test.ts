import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@bc5000/auth', () => ({
  clearCognitoTransactionCookie: () =>
    'bc5000_login=; Path=/auth; Max-Age=0',
  createSessionCookie: () =>
    Promise.resolve('bc5000_session=session; Path=/; HttpOnly'),
  exchangeCognitoCode: () => Promise.resolve({ subject: 'cognito-subject-1' }),
  readCognitoTransaction: () =>
    Promise.resolve({
      state: 'state-1',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      expiresAt: '2026-09-24T01:10:00.000Z',
      returnTo: '/approvals'
    })
}));

vi.mock('../../../server/runtime.js', () => ({
  getCognitoConfiguration: () => ({
    issuer: 'https://cognito-idp.ap-southeast-2.amazonaws.com/pool',
    clientId: 'client-id',
    redirectUri: 'https://billchaser.motts.com.au/auth/callback',
    authorizationEndpoint: 'https://auth.example.test/oauth2/authorize',
    tokenEndpoint: 'https://auth.example.test/oauth2/token'
  }),
  getSessionSecret: () => new Uint8Array(32).fill(1)
}));

import { GET } from './route.js';

describe('Cognito callback', () => {
  it('redirects to the public application origin after authentication', async () => {
    const request = new NextRequest(
      'https://ip-10-0-2-91.ap-southeast-2.compute.internal:3000/auth/callback?code=code-1&state=state-1'
    );

    const response = await GET(request);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://billchaser.motts.com.au/approvals'
    );
  });
});
