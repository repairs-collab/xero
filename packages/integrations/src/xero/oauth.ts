import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';

const AUTHORIZE_URL = 'https://identity.xero.com/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

export const requiredXeroOAuthScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.invoices',
  'accounting.contacts.read',
  'accounting.settings.read'
] as const;

export interface XeroOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
  idToken?: string;
}

export interface XeroOAuthConnection {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
  createdDateUtc: string;
  updatedDateUtc: string;
}

export type XeroOAuthFailureCode =
  | 'INVALID_GRANT'
  | 'MISSING_REQUIRED_SCOPE'
  | 'MALFORMED_RESPONSE'
  | 'PROVIDER_ERROR'
  | 'TRANSPORT_ERROR';

export class XeroOAuthFailure extends Error {
  constructor(
    public readonly code: XeroOAuthFailureCode,
    public readonly status: number | null,
    message = 'Xero OAuth request failed'
  ) {
    super(message);
    this.name = 'XeroOAuthFailure';
  }
}

export interface XeroOAuthClientOptions {
  http: HttpClient;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new XeroOAuthFailure(
      'MALFORMED_RESPONSE',
      null,
      'Xero OAuth returned a malformed response'
    );
  }
};

const providerErrorCode = (response: HttpResponse): string | null => {
  try {
    const value = JSON.parse(response.body) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const error = (value as { error?: unknown }).error;
    return typeof error === 'string' ? error : null;
  } catch {
    return null;
  }
};

const isConnection = (value: unknown): value is XeroOAuthConnection => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const connection = value as Record<string, unknown>;
  return (
    typeof connection.id === 'string' &&
    connection.id.length > 0 &&
    typeof connection.tenantId === 'string' &&
    connection.tenantId.length > 0 &&
    typeof connection.tenantType === 'string' &&
    typeof connection.tenantName === 'string' &&
    typeof connection.createdDateUtc === 'string' &&
    typeof connection.updatedDateUtc === 'string'
  );
};

export class XeroOAuthClient {
  constructor(private readonly options: XeroOAuthClientOptions) {}

  createAuthorizationUrl(state: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      scope: requiredXeroOAuthScopes.join(' '),
      state
    }).toString();
    return url.toString();
  }

  exchangeAuthorizationCode(code: string): Promise<XeroOAuthTokens> {
    return this.requestTokens(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.options.redirectUri
      })
    );
  }

  refreshAccessToken(refreshToken: string): Promise<XeroOAuthTokens> {
    return this.requestTokens(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    );
  }

  async listConnections(accessToken: string): Promise<XeroOAuthConnection[]> {
    const response = await this.send({
      method: 'GET',
      url: CONNECTIONS_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });
    this.assertSuccessful(response);

    const body = parseJson(response.body);
    if (!Array.isArray(body) || !body.every(isConnection)) {
      throw new XeroOAuthFailure(
        'MALFORMED_RESPONSE',
        response.status,
        'Xero OAuth returned malformed connections'
      );
    }
    return body;
  }

  async deleteConnection(accessToken: string, connectionId: string): Promise<void> {
    const response = await this.send({
      method: 'DELETE',
      url: `${CONNECTIONS_URL}/${encodeURIComponent(connectionId)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });
    this.assertSuccessful(response);
  }

  private async requestTokens(parameters: URLSearchParams): Promise<XeroOAuthTokens> {
    const response = await this.send({
      method: 'POST',
      url: TOKEN_URL,
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.options.clientId}:${this.options.clientSecret}`,
          'utf8'
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: parameters.toString()
    });

    if (response.status < 200 || response.status >= 300) {
      if (providerErrorCode(response) === 'invalid_grant') {
        throw new XeroOAuthFailure(
          'INVALID_GRANT',
          response.status,
          'Xero authorization must be renewed'
        );
      }
      this.assertSuccessful(response);
    }

    const body = parseJson(response.body) as RawTokenResponse;
    if (
      body === null ||
      typeof body !== 'object' ||
      typeof body.access_token !== 'string' ||
      body.access_token.length === 0 ||
      typeof body.refresh_token !== 'string' ||
      body.refresh_token.length === 0 ||
      typeof body.expires_in !== 'number' ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      typeof body.scope !== 'string' ||
      (body.id_token !== undefined && typeof body.id_token !== 'string')
    ) {
      throw new XeroOAuthFailure(
        'MALFORMED_RESPONSE',
        response.status,
        'Xero OAuth returned malformed token data'
      );
    }

    const scopes = body.scope.split(/\s+/).filter(Boolean);
    const missingScopes = requiredXeroOAuthScopes.filter(
      (scope) => !scopes.includes(scope)
    );
    if (missingScopes.length > 0) {
      throw new XeroOAuthFailure(
        'MISSING_REQUIRED_SCOPE',
        response.status,
        'Xero authorization is missing required permissions'
      );
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in,
      scopes,
      ...(body.id_token === undefined ? {} : { idToken: body.id_token })
    };
  }

  private async send(request: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.options.http.request(request);
    } catch {
      throw new XeroOAuthFailure(
        'TRANSPORT_ERROR',
        null,
        'Xero OAuth is temporarily unavailable'
      );
    }
  }

  private assertSuccessful(response: HttpResponse): void {
    if (response.status < 200 || response.status >= 300) {
      throw new XeroOAuthFailure(
        'PROVIDER_ERROR',
        response.status,
        'Xero OAuth provider rejected the request'
      );
    }
  }
}
