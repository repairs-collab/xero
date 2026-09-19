import type { HttpClient } from '../http.js';
import { XeroAuthenticationFailure } from './types.js';

export const requiredXeroScopes = [
  'accounting.invoices',
  'accounting.contacts.read',
  'accounting.settings.read'
] as const;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

export interface XeroClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface SecretReader {
  readXeroClientCredentials(): Promise<XeroClientCredentials>;
}

export interface IssuedXeroToken {
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export interface XeroTokenIssuer {
  issueToken(): Promise<IssuedXeroToken>;
}

export interface XeroTokenProvider {
  getAccessToken(): Promise<string>;
}

interface CachedToken {
  accessToken: string;
  refreshAtMilliseconds: number;
}

export class XeroTokenCache implements XeroTokenProvider {
  private cachedToken: CachedToken | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly issuer: XeroTokenIssuer,
    private readonly clock: Clock = systemClock
  ) {}

  async getAccessToken(): Promise<string> {
    if (
      this.cachedToken !== null &&
      this.clock.now().getTime() < this.cachedToken.refreshAtMilliseconds
    ) {
      return this.cachedToken.accessToken;
    }

    if (this.refreshPromise !== null) return this.refreshPromise;

    this.refreshPromise = this.refreshToken().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshToken(): Promise<string> {
    const issued = await this.issuer.issueToken();
    const missingScopes = requiredXeroScopes.filter(
      (scope) => !issued.scopes.includes(scope)
    );
    if (missingScopes.length > 0) {
      throw new XeroAuthenticationFailure(
        `Token is missing required Xero scopes: ${missingScopes.join(', ')}`
      );
    }

    this.cachedToken = {
      accessToken: issued.accessToken,
      refreshAtMilliseconds:
        this.clock.now().getTime() +
        issued.expiresInSeconds * 1000 -
        60_000
    };
    return issued.accessToken;
  }
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export class XeroClientCredentialsTokenIssuer implements XeroTokenIssuer {
  constructor(
    private readonly http: HttpClient,
    private readonly secrets: SecretReader
  ) {}

  async issueToken(): Promise<IssuedXeroToken> {
    const credentials = await this.secrets.readXeroClientCredentials();
    const response = await this.http.request({
      method: 'POST',
      url: 'https://identity.xero.com/connect/token',
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${credentials.clientId}:${credentials.clientSecret}`
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(
        requiredXeroScopes.join(' ')
      )}`
    });

    if (response.status === 401) {
      throw new XeroAuthenticationFailure();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new XeroAuthenticationFailure(
        `Xero token request failed with status ${response.status}`
      );
    }

    const body = JSON.parse(response.body) as TokenResponse;
    if (
      typeof body.access_token !== 'string' ||
      typeof body.expires_in !== 'number' ||
      typeof body.scope !== 'string'
    ) {
      throw new XeroAuthenticationFailure(
        'Xero token response was malformed'
      );
    }

    return {
      accessToken: body.access_token,
      expiresInSeconds: body.expires_in,
      scopes: body.scope.split(/\s+/).filter(Boolean)
    };
  }
}

export { XeroAuthenticationFailure } from './types.js';
