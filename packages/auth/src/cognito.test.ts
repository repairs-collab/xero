import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair
} from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  CognitoAuthenticationFailure,
  createCognitoTransactionCookie,
  createCognitoAuthorizationRequest,
  exchangeCognitoCode,
  readCognitoTransaction
} from './cognito.js';

const config = {
  issuer: 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_test',
  clientId: 'client-id',
  redirectUri: 'https://bill-chaser.test/auth/callback',
  authorizationEndpoint: 'https://auth.example.test/oauth2/authorize',
  tokenEndpoint: 'https://auth.example.test/oauth2/token'
};

describe('Cognito authorisation-code flow', () => {
  it('creates a stateful PKCE S256 request', () => {
    const request = createCognitoAuthorizationRequest(config, {
      now: new Date('2026-09-18T00:00:00.000Z')
    });
    const url = new URL(request.url);

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('state')).toBe(request.transaction.state);
    expect(url.searchParams.get('nonce')).toBe(request.transaction.nonce);
    expect(request.transaction.codeVerifier).toMatch(/^[\w-]{43}$/);
    expect(request.transaction.expiresAt).toBe('2026-09-18T00:10:00.000Z');
  });

  it('exchanges the code server-side and verifies issuer, audience and nonce', async () => {
    const request = createCognitoAuthorizationRequest(config);
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const idToken = await new SignJWT({ nonce: request.transaction.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(config.issuer)
      .setAudience(config.clientId)
      .setSubject('cognito-subject-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          id_token: idToken,
          access_token: 'access-token',
          token_type: 'Bearer',
          expires_in: 3600
        })
      )
    );

    const identity = await exchangeCognitoCode(
      {
        code: 'code-1',
        returnedState: request.transaction.state,
        transaction: request.transaction
      },
      config,
      {
        fetcher,
        jwks: createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key' }] })
      }
    );

    expect(identity).toEqual({ subject: 'cognito-subject-1' });
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    if (!(init?.body instanceof URLSearchParams)) {
      throw new Error('Expected form-encoded token request');
    }
    expect(init.body.has('code_verifier')).toBe(true);
  });

  it('rejects a state mismatch before calling the token endpoint', async () => {
    const request = createCognitoAuthorizationRequest(config);
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      exchangeCognitoCode(
        {
          code: 'code-1',
          returnedState: 'wrong-state',
          transaction: request.transaction
        },
        config,
        { fetcher }
      )
    ).rejects.toThrow(CognitoAuthenticationFailure);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('protects the PKCE verifier in an encrypted HTTP-only cookie', async () => {
    const transaction = createCognitoAuthorizationRequest(config).transaction;
    const secret = new Uint8Array(32).fill(4);
    const cookie = await createCognitoTransactionCookie(transaction, secret);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain(transaction.codeVerifier);

    await expect(
      readCognitoTransaction(
        new Request('https://bill-chaser.test/auth/callback', {
          headers: { cookie: cookie.split(';')[0] ?? '' }
        }),
        secret
      )
    ).resolves.toEqual(transaction);
  });
});
