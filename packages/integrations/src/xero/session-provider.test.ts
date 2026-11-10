import { describe, expect, it } from 'vitest';

import type { Clock, XeroTokenProvider } from './token-cache.js';
import type {
  EncryptedTokenEnvelope,
  TokenCipher
} from './token-encryption.js';
import { XeroOAuthFailure, type XeroOAuthTokens } from './oauth.js';
import {
  LegacyXeroSessionProvider,
  XeroOAuthSessionProvider,
  type CompleteXeroRefreshLeaseInput,
  type StoredXeroConnection,
  type XeroRefreshTokenStore
} from './session-provider.js';

class FakeClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

class RecordingCipher implements TokenCipher {
  decrypted: string[] = [];
  encrypted: string[] = [];

  encrypt(plaintext: string): EncryptedTokenEnvelope {
    this.encrypted.push(plaintext);
    return tokenEnvelope(plaintext);
  }

  decrypt(envelope: EncryptedTokenEnvelope): string {
    const plaintext = Buffer.from(envelope.ciphertext, 'base64').toString('utf8');
    this.decrypted.push(plaintext);
    return plaintext;
  }
}

class SharedRefreshTokenStore implements XeroRefreshTokenStore {
  connection: StoredXeroConnection;
  completed: CompleteXeroRefreshLeaseInput[] = [];
  released: string[] = [];
  reauthRequired = false;
  acquireAttempts = 0;

  constructor(connection: StoredXeroConnection) {
    this.connection = { ...connection };
  }

  findByOrganisationId(organisationId: string): Promise<StoredXeroConnection | null> {
    return Promise.resolve(
      this.connection.organisationId === organisationId
        ? { ...this.connection }
        : null
    );
  }

  acquireRefreshLease(input: {
    organisationId: string;
    leaseId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<StoredXeroConnection | null> {
    this.acquireAttempts += 1;
    const leaseAvailable =
      this.connection.refreshLeaseId === null ||
      (this.connection.refreshLeaseExpiresAt !== null &&
        this.connection.refreshLeaseExpiresAt.getTime() <= input.now.getTime());
    if (
      this.connection.organisationId !== input.organisationId ||
      this.connection.status !== 'CONNECTED' ||
      !leaseAvailable
    ) {
      return Promise.resolve(null);
    }
    this.connection = {
      ...this.connection,
      refreshLeaseId: input.leaseId,
      refreshLeaseExpiresAt: input.expiresAt
    };
    return Promise.resolve({ ...this.connection });
  }

  completeRefreshLease(
    input: CompleteXeroRefreshLeaseInput
  ): Promise<StoredXeroConnection> {
    if (this.connection.refreshLeaseId !== input.leaseId) {
      return Promise.reject(new Error('XERO_REFRESH_LEASE_NOT_OWNED'));
    }
    this.completed.push(input);
    this.connection = {
      ...this.connection,
      encryptedRefreshToken: input.encryptedRefreshToken,
      grantedScopes: [...input.grantedScopes],
      refreshTokenVersion: this.connection.refreshTokenVersion + 1,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    };
    return Promise.resolve({ ...this.connection });
  }

  releaseRefreshLease(
    organisationId: string,
    leaseId: string
  ): Promise<boolean> {
    if (
      this.connection.organisationId !== organisationId ||
      this.connection.refreshLeaseId !== leaseId
    ) {
      return Promise.resolve(false);
    }
    this.released.push(leaseId);
    this.connection = {
      ...this.connection,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    };
    return Promise.resolve(true);
  }

  markReauthRequired(organisationId: string): Promise<StoredXeroConnection> {
    if (this.connection.organisationId !== organisationId) {
      return Promise.reject(new Error('XERO_CONNECTION_NOT_FOUND'));
    }
    this.reauthRequired = true;
    this.connection = {
      ...this.connection,
      status: 'REAUTH_REQUIRED',
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    };
    return Promise.resolve({ ...this.connection });
  }
}

const tokenEnvelope = (token: string): EncryptedTokenEnvelope => ({
  version: 1,
  keyId: 'test',
  iv: Buffer.alloc(12).toString('base64'),
  ciphertext: Buffer.from(token).toString('base64'),
  tag: Buffer.alloc(16).toString('base64')
});

const connection = (
  overrides: Partial<StoredXeroConnection> = {}
): StoredXeroConnection => ({
  organisationId: 'organisation-id',
  tenantId: 'tenant-id',
  status: 'CONNECTED',
  encryptedRefreshToken: tokenEnvelope('refresh-1'),
  grantedScopes: ['openid', 'offline_access', 'accounting.invoices'],
  refreshTokenVersion: 1,
  refreshLeaseId: null,
  refreshLeaseExpiresAt: null,
  ...overrides
});

const tokens = (
  accessToken: string,
  refreshToken: string,
  expiresInSeconds = 1800
): XeroOAuthTokens => ({
  accessToken,
  refreshToken,
  expiresInSeconds,
  scopes: ['openid', 'profile', 'email', 'offline_access', 'accounting.invoices']
});

const provider = (input: {
  store: XeroRefreshTokenStore;
  cipher: TokenCipher;
  clock: Clock;
  refresh: (refreshToken: string) => Promise<XeroOAuthTokens>;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseId?: () => string;
  maxWaitMilliseconds?: number;
}) =>
  new XeroOAuthSessionProvider({
    organisationId: 'organisation-id',
    store: input.store,
    tokenCipher: input.cipher,
    oauthClient: { refreshAccessToken: input.refresh },
    clock: input.clock,
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
    leaseDurationMilliseconds: 30_000,
    pollIntervalMilliseconds: 100,
    maxWaitMilliseconds: input.maxWaitMilliseconds ?? 2_000
  });

describe('XeroOAuthSessionProvider', () => {
  it('keeps access tokens only in memory and rotates only encrypted refresh material', async () => {
    const clock = new FakeClock(new Date('2026-11-09T00:00:00.000Z'));
    const store = new SharedRefreshTokenStore(connection());
    const cipher = new RecordingCipher();
    const refreshTokens: string[] = [];
    let refreshCount = 0;
    const sessionProvider = provider({
      store,
      cipher,
      clock,
      leaseId: () => 'lease-one',
      refresh: (refreshToken) => {
        refreshTokens.push(refreshToken);
        refreshCount += 1;
        return Promise.resolve(
          tokens(`access-${refreshCount}`, `refresh-${refreshCount + 1}`, 120)
        );
      }
    });

    await expect(sessionProvider.getSession()).resolves.toEqual({
      accessToken: 'access-1',
      tenantId: 'tenant-id'
    });
    clock.advance(59_000);
    await expect(sessionProvider.getSession()).resolves.toEqual({
      accessToken: 'access-1',
      tenantId: 'tenant-id'
    });
    clock.advance(1_000);
    await expect(sessionProvider.getSession()).resolves.toEqual({
      accessToken: 'access-2',
      tenantId: 'tenant-id'
    });

    expect(refreshTokens).toEqual(['refresh-1', 'refresh-2']);
    expect(cipher.decrypted).toEqual(['refresh-1', 'refresh-2']);
    expect(cipher.encrypted).toEqual(['refresh-2', 'refresh-3']);
    expect(store.completed).toHaveLength(2);
    expect(JSON.stringify(store.completed)).not.toContain('access-1');
    expect(JSON.stringify(store.completed)).not.toContain('access-2');
    expect(store.connection.encryptedRefreshToken).toEqual(tokenEnvelope('refresh-3'));
  });

  it('waits for another provider token version before refreshing the newly rotated token', async () => {
    const clock = new FakeClock(new Date('2026-11-09T01:00:00.000Z'));
    const store = new SharedRefreshTokenStore(connection());
    const firstCipher = new RecordingCipher();
    const secondCipher = new RecordingCipher();
    let finishFirstRefresh: ((value: XeroOAuthTokens) => void) | undefined;
    const first = provider({
      store,
      cipher: firstCipher,
      clock,
      leaseId: () => 'first-lease',
      refresh: () =>
        new Promise((resolve) => {
          finishFirstRefresh = resolve;
        })
    });
    const secondRefreshInputs: string[] = [];
    const second = provider({
      store,
      cipher: secondCipher,
      clock,
      leaseId: () => 'second-lease',
      refresh: (refreshToken) => {
        secondRefreshInputs.push(refreshToken);
        return Promise.resolve(tokens('second-access', 'refresh-3'));
      },
      sleep: async (milliseconds) => {
        finishFirstRefresh?.(tokens('first-access', 'refresh-2'));
        clock.advance(milliseconds);
        await Promise.resolve();
      }
    });

    const firstSession = first.getSession();
    await Promise.resolve();
    const secondSession = second.getSession();

    await expect(firstSession).resolves.toMatchObject({ accessToken: 'first-access' });
    await expect(secondSession).resolves.toMatchObject({ accessToken: 'second-access' });
    expect(secondRefreshInputs).toEqual(['refresh-2']);
    expect(secondCipher.decrypted).toEqual(['refresh-2']);
  });

  it('takes over an expired lease', async () => {
    const clock = new FakeClock(new Date('2026-11-09T02:00:00.000Z'));
    const store = new SharedRefreshTokenStore(
      connection({
        refreshLeaseId: 'crashed-worker',
        refreshLeaseExpiresAt: new Date('2026-11-09T01:59:59.000Z')
      })
    );
    const sessionProvider = provider({
      store,
      cipher: new RecordingCipher(),
      clock,
      leaseId: () => 'replacement-worker',
      refresh: () => Promise.resolve(tokens('replacement-access', 'refresh-2'))
    });

    await expect(sessionProvider.getSession()).resolves.toMatchObject({
      accessToken: 'replacement-access'
    });
    expect(store.completed[0]?.leaseId).toBe('replacement-worker');
  });

  it('marks invalid_grant for reauthentication without storing token data', async () => {
    const clock = new FakeClock(new Date('2026-11-09T03:00:00.000Z'));
    const store = new SharedRefreshTokenStore(connection());
    const sessionProvider = provider({
      store,
      cipher: new RecordingCipher(),
      clock,
      leaseId: () => 'invalid-grant-lease',
      refresh: () =>
        Promise.reject(
          new XeroOAuthFailure('INVALID_GRANT', 400, 'renew authorization')
        )
    });

    await expect(sessionProvider.getSession()).rejects.toMatchObject({
      code: 'INVALID_GRANT'
    });
    expect(store.reauthRequired).toBe(true);
    expect(store.connection.status).toBe('REAUTH_REQUIRED');
  });

  it('releases the lease after a transient provider failure', async () => {
    const clock = new FakeClock(new Date('2026-11-09T04:00:00.000Z'));
    const store = new SharedRefreshTokenStore(connection());
    const sessionProvider = provider({
      store,
      cipher: new RecordingCipher(),
      clock,
      leaseId: () => 'transient-lease',
      refresh: () =>
        Promise.reject(
          new XeroOAuthFailure('TRANSPORT_ERROR', null, 'temporarily unavailable')
        )
    });

    await expect(sessionProvider.getSession()).rejects.toMatchObject({
      code: 'TRANSPORT_ERROR'
    });
    expect(store.released).toEqual(['transient-lease']);
    expect(store.connection.refreshLeaseId).toBeNull();
  });

  it('bounds waiting for an active lease that never completes', async () => {
    const clock = new FakeClock(new Date('2026-11-09T05:00:00.000Z'));
    const store = new SharedRefreshTokenStore(
      connection({
        refreshLeaseId: 'stuck-worker',
        refreshLeaseExpiresAt: new Date('2026-11-09T05:10:00.000Z')
      })
    );
    const sessionProvider = provider({
      store,
      cipher: new RecordingCipher(),
      clock,
      maxWaitMilliseconds: 300,
      leaseId: () => 'waiting-worker',
      refresh: () => Promise.reject(new Error('must not refresh')),
      sleep: (milliseconds) => {
        clock.advance(milliseconds);
        return Promise.resolve();
      }
    });

    await expect(sessionProvider.getSession()).rejects.toThrow(
      'XERO_REFRESH_WAIT_TIMEOUT'
    );
    expect(store.completed).toHaveLength(0);
  });
});

describe('LegacyXeroSessionProvider', () => {
  it('wraps the Custom Connection token provider without a tenant id', async () => {
    const legacy: XeroTokenProvider = {
      getAccessToken: () => Promise.resolve('legacy-access')
    };

    await expect(new LegacyXeroSessionProvider(legacy).getSession()).resolves.toEqual({
      accessToken: 'legacy-access',
      tenantId: null
    });
  });
});
