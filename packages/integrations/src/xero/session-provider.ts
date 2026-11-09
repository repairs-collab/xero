import { randomUUID } from 'node:crypto';

import type { XeroOAuthClient, XeroOAuthTokens } from './oauth.js';
import { XeroOAuthFailure } from './oauth.js';
import type { Clock, XeroTokenProvider } from './token-cache.js';
import { systemClock } from './token-cache.js';
import type {
  EncryptedTokenEnvelope,
  TokenCipher
} from './token-encryption.js';

export interface XeroAuthorisedSession {
  accessToken: string;
  tenantId: string | null;
}

export interface XeroSessionProvider {
  getSession(): Promise<XeroAuthorisedSession>;
}

export interface StoredXeroConnection {
  organisationId: string;
  tenantId: string;
  status: 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECTED';
  encryptedRefreshToken: EncryptedTokenEnvelope | null;
  grantedScopes: string[];
  refreshTokenVersion: number;
  refreshLeaseId: string | null;
  refreshLeaseExpiresAt: Date | null;
}

export interface AcquireXeroRefreshLeaseInput {
  organisationId: string;
  leaseId: string;
  now: Date;
  expiresAt: Date;
}

export interface CompleteXeroRefreshLeaseInput {
  organisationId: string;
  leaseId: string;
  encryptedRefreshToken: EncryptedTokenEnvelope;
  grantedScopes: string[];
  now: Date;
}

export interface XeroRefreshTokenStore {
  findByOrganisationId(
    organisationId: string
  ): Promise<StoredXeroConnection | null>;
  acquireRefreshLease(
    input: AcquireXeroRefreshLeaseInput
  ): Promise<StoredXeroConnection | null>;
  completeRefreshLease(
    input: CompleteXeroRefreshLeaseInput
  ): Promise<StoredXeroConnection>;
  releaseRefreshLease(
    organisationId: string,
    leaseId: string,
    now: Date
  ): Promise<boolean>;
  markReauthRequired(
    organisationId: string,
    now: Date
  ): Promise<StoredXeroConnection>;
}

interface XeroOAuthRefresher {
  refreshAccessToken(refreshToken: string): Promise<XeroOAuthTokens>;
}

export interface XeroOAuthSessionProviderOptions {
  organisationId: string;
  store: XeroRefreshTokenStore;
  tokenCipher: TokenCipher;
  oauthClient: Pick<XeroOAuthClient, 'refreshAccessToken'> | XeroOAuthRefresher;
  clock?: Clock;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseId?: () => string;
  leaseDurationMilliseconds?: number;
  pollIntervalMilliseconds?: number;
  maxWaitMilliseconds?: number;
}

interface CachedSession {
  session: XeroAuthorisedSession;
  refreshAtMilliseconds: number;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class XeroOAuthSessionProvider implements XeroSessionProvider {
  private readonly clock: Clock;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly createLeaseId: () => string;
  private readonly leaseDurationMilliseconds: number;
  private readonly pollIntervalMilliseconds: number;
  private readonly maxWaitMilliseconds: number;
  private cached: CachedSession | null = null;
  private refreshPromise: Promise<XeroAuthorisedSession> | null = null;

  constructor(private readonly options: XeroOAuthSessionProviderOptions) {
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? defaultSleep;
    this.createLeaseId = options.leaseId ?? randomUUID;
    this.leaseDurationMilliseconds = options.leaseDurationMilliseconds ?? 30_000;
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 250;
    this.maxWaitMilliseconds = options.maxWaitMilliseconds ?? 15_000;
  }

  async getSession(): Promise<XeroAuthorisedSession> {
    if (
      this.cached !== null &&
      this.clock.now().getTime() < this.cached.refreshAtMilliseconds
    ) {
      return this.cached.session;
    }

    if (this.refreshPromise !== null) return this.refreshPromise;
    this.refreshPromise = this.refreshSession().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshSession(): Promise<XeroAuthorisedSession> {
    const deadline = this.clock.now().getTime() + this.maxWaitMilliseconds;
    let observed = await this.requireConnectedConnection();

    while (this.clock.now().getTime() < deadline) {
      const now = this.clock.now();
      const leaseId = this.createLeaseId();
      const acquired = await this.options.store.acquireRefreshLease({
        organisationId: this.options.organisationId,
        leaseId,
        now,
        expiresAt: new Date(now.getTime() + this.leaseDurationMilliseconds)
      });
      if (acquired !== null) {
        return this.refreshAsLeaseOwner(acquired, leaseId);
      }

      const observedVersion = observed.refreshTokenVersion;
      await this.sleep(this.pollIntervalMilliseconds);
      observed = await this.requireConnectedConnection();
      if (observed.refreshTokenVersion > observedVersion) {
        continue;
      }
    }

    throw new Error('XERO_REFRESH_WAIT_TIMEOUT');
  }

  private async refreshAsLeaseOwner(
    connection: StoredXeroConnection,
    leaseId: string
  ): Promise<XeroAuthorisedSession> {
    try {
      if (connection.encryptedRefreshToken === null) {
        throw new Error('XERO_REFRESH_TOKEN_MISSING');
      }
      const refreshToken = this.options.tokenCipher.decrypt(
        connection.encryptedRefreshToken
      );
      const tokens = await this.options.oauthClient.refreshAccessToken(refreshToken);
      const encryptedRefreshToken = this.options.tokenCipher.encrypt(
        tokens.refreshToken
      );
      await this.options.store.completeRefreshLease({
        organisationId: this.options.organisationId,
        leaseId,
        encryptedRefreshToken,
        grantedScopes: tokens.scopes,
        now: this.clock.now()
      });

      const session = {
        accessToken: tokens.accessToken,
        tenantId: connection.tenantId
      };
      this.cached = {
        session,
        refreshAtMilliseconds:
          this.clock.now().getTime() +
          Math.max(0, tokens.expiresInSeconds * 1000 - 60_000)
      };
      return session;
    } catch (error) {
      if (error instanceof XeroOAuthFailure && error.code === 'INVALID_GRANT') {
        await this.options.store.markReauthRequired(
          this.options.organisationId,
          this.clock.now()
        );
        throw error;
      }
      await this.options.store.releaseRefreshLease(
        this.options.organisationId,
        leaseId,
        this.clock.now()
      );
      throw error;
    }
  }

  private async requireConnectedConnection(): Promise<StoredXeroConnection> {
    const connection = await this.options.store.findByOrganisationId(
      this.options.organisationId
    );
    if (connection === null) throw new Error('XERO_CONNECTION_REQUIRED');
    if (connection.status === 'REAUTH_REQUIRED') {
      throw new Error('XERO_REAUTH_REQUIRED');
    }
    if (connection.status !== 'CONNECTED') {
      throw new Error('XERO_CONNECTION_DISCONNECTED');
    }
    return connection;
  }
}

export class LegacyXeroSessionProvider implements XeroSessionProvider {
  constructor(private readonly tokenProvider: XeroTokenProvider) {}

  async getSession(): Promise<XeroAuthorisedSession> {
    return {
      accessToken: await this.tokenProvider.getAccessToken(),
      tenantId: null
    };
  }
}
