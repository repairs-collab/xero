import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import {
  requiredXeroScopes,
  XeroAuthenticationFailure,
  XeroClientCredentialsTokenIssuer,
  XeroTokenCache,
  type Clock,
  type IssuedXeroToken,
  type SecretReader,
  type XeroTokenIssuer
} from './token-cache.js';

class FakeClock implements Clock {
  private instant: Date;

  constructor(instant: string) {
    this.instant = new Date(instant);
  }

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

class FakeTokenIssuer implements XeroTokenIssuer {
  calls = 0;

  constructor(private readonly tokens: IssuedXeroToken[]) {}

  issueToken(): Promise<IssuedXeroToken> {
    const token = this.tokens[Math.min(this.calls, this.tokens.length - 1)];
    this.calls += 1;
    if (token === undefined) throw new Error('No fake token configured');
    return Promise.resolve(token);
  }
}

class FakeHttpClient implements HttpClient {
  requests: HttpRequest[] = [];
  responses: HttpResponse[] = [];

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fake response configured');
    return Promise.resolve(response);
  }
}

const issuedToken = (
  accessToken: string,
  scopes: readonly string[] = requiredXeroScopes
): IssuedXeroToken => ({
  accessToken,
  expiresInSeconds: 1800,
  scopes: [...scopes]
});

describe('XeroTokenCache', () => {
  it('reuses a token until sixty seconds before expiry', async () => {
    const clock = new FakeClock('2026-09-18T00:00:00Z');
    const issuer = new FakeTokenIssuer([issuedToken('token-1')]);
    const provider = new XeroTokenCache(issuer, clock);

    expect(await provider.getAccessToken()).toBe('token-1');
    clock.advance(28 * 60 * 1000);
    expect(await provider.getAccessToken()).toBe('token-1');
    expect(issuer.calls).toBe(1);
  });

  it('refreshes at the sixty-second safety boundary', async () => {
    const clock = new FakeClock('2026-09-18T00:00:00Z');
    const issuer = new FakeTokenIssuer([
      issuedToken('token-1'),
      issuedToken('token-2')
    ]);
    const provider = new XeroTokenCache(issuer, clock);

    expect(await provider.getAccessToken()).toBe('token-1');
    clock.advance(29 * 60 * 1000);
    expect(await provider.getAccessToken()).toBe('token-2');
  });

  it('coalesces concurrent refreshes behind one issuer request', async () => {
    let resolveToken: ((token: IssuedXeroToken) => void) | undefined;
    let calls = 0;
    const issuer: XeroTokenIssuer = {
      issueToken: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveToken = resolve;
        });
      }
    };
    const provider = new XeroTokenCache(
      issuer,
      new FakeClock('2026-09-18T00:00:00Z')
    );

    const first = provider.getAccessToken();
    const second = provider.getAccessToken();
    resolveToken?.(issuedToken('shared-token'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      'shared-token',
      'shared-token'
    ]);
    expect(calls).toBe(1);
  });

  it('rejects a token missing any required scope', async () => {
    const issuer = new FakeTokenIssuer([
      issuedToken('incomplete-token', ['accounting.invoices'])
    ]);
    const provider = new XeroTokenCache(
      issuer,
      new FakeClock('2026-09-18T00:00:00Z')
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      'missing required Xero scopes'
    );
  });
});

describe('XeroClientCredentialsTokenIssuer', () => {
  it('uses Basic authentication and the exact Custom Connection scope body', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({
        access_token: 'access-token',
        expires_in: 1800,
        scope: requiredXeroScopes.join(' ')
      })
    });
    const secrets: SecretReader = {
      readXeroClientCredentials: () =>
        Promise.resolve({
          clientId: 'client-id',
          clientSecret: 'client-secret'
        })
    };
    const issuer = new XeroClientCredentialsTokenIssuer(http, secrets);

    await expect(issuer.issueToken()).resolves.toMatchObject({
      accessToken: 'access-token',
      expiresInSeconds: 1800
    });
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://identity.xero.com/connect/token',
      headers: {
        Authorization: `Basic ${Buffer.from(
          'client-id:client-secret'
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body:
        'grant_type=client_credentials&scope=accounting.invoices%20accounting.contacts.read%20accounting.settings.read'
    });
  });

  it('maps a token 401 to XeroAuthenticationFailure', async () => {
    const http = new FakeHttpClient();
    http.responses.push({ status: 401, headers: {}, body: '' });
    const issuer = new XeroClientCredentialsTokenIssuer(http, {
      readXeroClientCredentials: () =>
        Promise.resolve({
          clientId: 'client-id',
          clientSecret: 'client-secret'
        })
    });

    await expect(issuer.issueToken()).rejects.toBeInstanceOf(
      XeroAuthenticationFailure
    );
  });
});
