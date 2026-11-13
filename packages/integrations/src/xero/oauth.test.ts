import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import {
  requiredXeroOAuthScopes,
  XeroOAuthClient,
  XeroOAuthFailure
} from './oauth.js';

class FakeHttpClient implements HttpClient {
  requests: HttpRequest[] = [];
  responses: Array<HttpResponse | Error> = [];

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fake response configured');
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  }
}

const tokenResponse = (overrides: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'rotated-refresh-token',
    expires_in: 1800,
    scope: requiredXeroOAuthScopes.join(' '),
    id_token: 'identity-token',
    ...overrides
  })
});

const createClient = (http: HttpClient): XeroOAuthClient =>
  new XeroOAuthClient({
    http,
    clientId: 'customer-client-id',
    clientSecret: 'customer-client-secret',
    redirectUri: 'https://ap.motts.com.au/xero/callback'
  });

const expectFailureCode = async (
  operation: Promise<unknown>,
  code: XeroOAuthFailure['code']
): Promise<void> => {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(XeroOAuthFailure);
  expect((failure as XeroOAuthFailure).code).toBe(code);
};

describe('XeroOAuthClient', () => {
  it('creates an authorization URL with exact standard scopes and unmodified state', () => {
    const state = 'opaque.state+with/slashes==';
    const url = new URL(createClient(new FakeHttpClient()).createAuthorizationUrl(state));

    expect(`${url.origin}${url.pathname}`).toBe(
      'https://identity.xero.com/connect/authorize'
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('customer-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://ap.motts.com.au/xero/callback'
    );
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      ...requiredXeroOAuthScopes
    ]);
    expect(url.searchParams.get('state')).toBe(state);
  });

  it('exchanges an authorization code with Basic client authentication', async () => {
    const http = new FakeHttpClient();
    http.responses.push(tokenResponse());
    const client = createClient(http);

    await expect(client.exchangeAuthorizationCode('authorization-code')).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'rotated-refresh-token',
      expiresInSeconds: 1800,
      scopes: [...requiredXeroOAuthScopes],
      idToken: 'identity-token'
    });
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://identity.xero.com/connect/token',
      headers: {
        Authorization: `Basic ${Buffer.from(
          'customer-client-id:customer-client-secret'
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      }
    });
    expect(new URLSearchParams(http.requests[0]?.body)).toEqual(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'authorization-code',
        redirect_uri: 'https://ap.motts.com.au/xero/callback'
      })
    );
  });

  it('refreshes using the prior token and returns Xero rotating refresh material', async () => {
    const http = new FakeHttpClient();
    http.responses.push(tokenResponse({
      access_token: 'new-access-token',
      refresh_token: 'new-rotating-refresh-token'
    }));
    const client = createClient(http);

    await expect(client.refreshAccessToken('prior-refresh-token')).resolves.toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-rotating-refresh-token'
    });
    expect(new URLSearchParams(http.requests[0]?.body)).toEqual(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'prior-refresh-token'
      })
    );
  });

  it('lists connections and deletes only the selected Xero connection', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify([
        {
          id: 'connection-id',
          tenantId: 'tenant-id',
          tenantType: 'ORGANISATION',
          tenantName: 'Example Pty Ltd',
          createdDateUtc: '2026-11-09T00:00:00Z',
          updatedDateUtc: '2026-11-09T00:00:00Z'
        }
      ])
    });
    http.responses.push({ status: 204, headers: {}, body: '' });
    const client = createClient(http);

    await expect(client.listConnections('access-token')).resolves.toEqual([
      expect.objectContaining({
        id: 'connection-id',
        tenantId: 'tenant-id',
        tenantName: 'Example Pty Ltd'
      })
    ]);
    await expect(
      client.deleteConnection('access-token', 'connection/id')
    ).resolves.toBeUndefined();
    expect(http.requests).toMatchObject([
      {
        method: 'GET',
        url: 'https://api.xero.com/connections',
        headers: { Authorization: 'Bearer access-token' }
      },
      {
        method: 'DELETE',
        url: 'https://api.xero.com/connections/connection%2Fid',
        headers: { Authorization: 'Bearer access-token' }
      }
    ]);
  });

  it('treats an already-absent Xero connection as an idempotent delete success', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 404,
      headers: {},
      body: 'provider details must not escape'
    });

    await expect(
      createClient(http).deleteConnection('access-token', 'missing-connection')
    ).resolves.toBeUndefined();
    expect(http.requests).toMatchObject([
      {
        method: 'DELETE',
        url: 'https://api.xero.com/connections/missing-connection',
        headers: { Authorization: 'Bearer access-token' }
      }
    ]);
  });

  it('bounds a Xero connection delete with an abort signal', async () => {
    let deleteSignal: AbortSignal | undefined;
    const http: HttpClient = {
      request: (request) => {
        deleteSignal = (
          request as HttpRequest & { signal?: AbortSignal }
        ).signal;
        return Promise.resolve({ status: 204, headers: {}, body: '' });
      }
    };
    const client = new XeroOAuthClient({
      http,
      clientId: 'customer-client-id',
      clientSecret: 'customer-client-secret',
      redirectUri: 'https://ap.motts.com.au/xero/callback',
      disconnectTimeoutMilliseconds: 5
    });

    await client.deleteConnection('access-token', 'connection-id');
    expect(deleteSignal).toBeInstanceOf(AbortSignal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deleteSignal?.aborted).toBe(true);
  });

  it('maps malformed token and connection responses without exposing provider bodies', async () => {
    const malformedTokenHttp = new FakeHttpClient();
    malformedTokenHttp.responses.push({ status: 200, headers: {}, body: '{bad-json' });
    await expectFailureCode(
      createClient(malformedTokenHttp).exchangeAuthorizationCode('code'),
      'MALFORMED_RESPONSE'
    );

    const malformedConnectionsHttp = new FakeHttpClient();
    malformedConnectionsHttp.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify([{ id: 'connection-without-tenant' }])
    });
    await expectFailureCode(
      createClient(malformedConnectionsHttp).listConnections('access-token'),
      'MALFORMED_RESPONSE'
    );
  });

  it('maps invalid_grant distinctly so callers can require reconnection', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 400,
      headers: {},
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'expired' })
    });

    await expectFailureCode(
      createClient(http).refreshAccessToken('expired-refresh-token'),
      'INVALID_GRANT'
    );
  });

  it('rejects a successful token response missing offline_access', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      tokenResponse({
        scope: requiredXeroOAuthScopes
          .filter((scope) => scope !== 'offline_access')
          .join(' ')
      })
    );

    await expectFailureCode(
      createClient(http).exchangeAuthorizationCode('code'),
      'MISSING_REQUIRED_SCOPE'
    );
  });

  it('maps timeouts and non-2xx provider responses to typed failures', async () => {
    const timeoutHttp = new FakeHttpClient();
    timeoutHttp.responses.push(new Error('request timed out with a sensitive URL'));
    await expectFailureCode(
      createClient(timeoutHttp).exchangeAuthorizationCode('code'),
      'TRANSPORT_ERROR'
    );

    const providerHttp = new FakeHttpClient();
    providerHttp.responses.push({
      status: 503,
      headers: {},
      body: 'provider response must not leak'
    });
    await expectFailureCode(
      createClient(providerHttp).listConnections('access-token'),
      'PROVIDER_ERROR'
    );
  });
});
