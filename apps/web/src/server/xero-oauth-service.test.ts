import { describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import type { XeroTenantCandidate } from '@bc5000/db/web';
import type {
  EncryptedTokenEnvelope,
  TokenCipher,
  XeroAuthorisedSession,
  XeroOAuthConnection,
  XeroOAuthTokens
} from '@bc5000/integrations/xero';

import {
  createXeroOAuthService,
  type XeroOAuthAuditEvent,
  type XeroOAuthRepository,
  type XeroOAuthServiceDependencies
} from './xero-oauth-service.js';

const adminSession: AppSession = {
  userId: 'admin-user',
  cognitoSubject: 'cognito-admin',
  displayName: 'Admin',
  expiresAt: '2026-11-10T00:00:00.000Z',
  memberships: [
    { organisationId: 'organisation-one', role: 'ADMIN', active: true }
  ]
};

const operatorSession: AppSession = {
  ...adminSession,
  userId: 'operator-user',
  memberships: [
    { organisationId: 'organisation-one', role: 'OPERATOR', active: true }
  ]
};

const provisionalSession: AppSession = {
  userId: 'solo-owner-user',
  cognitoSubject: 'cognito-solo-owner',
  displayName: 'Solo Owner',
  expiresAt: '2026-11-10T00:00:00.000Z',
  memberships: []
};

const secondAdminSession: AppSession = {
  ...adminSession,
  userId: 'second-admin-user'
};

const envelope = (token: string): EncryptedTokenEnvelope => ({
  version: 1,
  keyId: 'test',
  iv: Buffer.alloc(12).toString('base64'),
  ciphertext: Buffer.from(token).toString('base64'),
  tag: Buffer.alloc(16).toString('base64')
});

class FakeCipher implements TokenCipher {
  plaintexts: string[] = [];

  encrypt(plaintext: string): EncryptedTokenEnvelope {
    this.plaintexts.push(plaintext);
    return envelope(plaintext);
  }

  decrypt(value: EncryptedTokenEnvelope): string {
    return Buffer.from(value.ciphertext, 'base64').toString('utf8');
  }
}

class FakeRepository implements XeroOAuthRepository {
  transaction:
    | {
        id: string;
        stateHash: string;
        userId: string;
        existingOrganisationId: string | null;
        flowPurpose: 'NEW_SOLO' | 'CONNECT_EXISTING';
        returnPath: string;
        expiresAt: Date;
        consumed: boolean;
      }
    | undefined;
  pending:
    | {
        id: string;
        userId: string;
        existingOrganisationId: string | null;
        candidateTenants: XeroTenantCandidate[];
        encryptedRefreshToken: EncryptedTokenEnvelope;
        grantedScopes: string[];
        expiresAt: Date;
      }
    | undefined;
  connection: Awaited<ReturnType<XeroOAuthRepository['findByOrganisationId']>> = null;

  createOAuthTransaction(input: {
    stateHash: string;
    userId: string;
    existingOrganisationId: string | null;
    flowPurpose: 'NEW_SOLO' | 'CONNECT_EXISTING';
    returnPath: string;
    expiresAt: Date;
  }): Promise<string> {
    this.transaction = { id: 'transaction-id', ...input, consumed: false };
    return Promise.resolve('transaction-id');
  }

  consumeOAuthTransaction(input: {
    stateHash: string;
    userId: string;
    existingOrganisationId: string | null;
    now: Date;
  }): Promise<{
    flowPurpose: 'NEW_SOLO' | 'CONNECT_EXISTING';
    existingOrganisationId: string | null;
    returnPath: string;
  }> {
    const value = this.transaction;
    if (
      value === undefined ||
      value.consumed ||
      value.stateHash !== input.stateHash ||
      value.userId !== input.userId ||
      value.existingOrganisationId !== input.existingOrganisationId ||
      value.expiresAt.getTime() <= input.now.getTime()
    ) {
      return Promise.reject(new Error('XERO_OAUTH_TRANSACTION_INVALID'));
    }
    value.consumed = true;
    return Promise.resolve(value);
  }

  createPendingAuthorisation(input: {
    userId: string;
    existingOrganisationId: string | null;
    flowPurpose: 'NEW_SOLO' | 'CONNECT_EXISTING';
    encryptedRefreshToken: EncryptedTokenEnvelope;
    candidateTenants: XeroTenantCandidate[];
    grantedScopes: string[];
    expiresAt: Date;
  }): Promise<string> {
    this.pending = { id: 'pending-id', ...input };
    return Promise.resolve('pending-id');
  }

  findPendingAuthorisation(input: {
    pendingAuthorisationId: string;
    userId: string;
    existingOrganisationId: string | null;
    now: Date;
  }): Promise<
    | {
        candidateTenants: XeroTenantCandidate[];
        encryptedRefreshToken: EncryptedTokenEnvelope;
      }
    | null
  > {
    const pending = this.pending;
    return Promise.resolve(
      pending !== undefined &&
        pending.id === input.pendingAuthorisationId &&
        pending.userId === input.userId &&
        pending.existingOrganisationId === input.existingOrganisationId &&
        pending.expiresAt.getTime() > input.now.getTime()
        ? pending
        : null
    );
  }

  finalisePendingAuthorisation(input: {
    pendingAuthorisationId: string;
    userId: string;
    existingOrganisationId: string | null;
    organisationId: string;
    connectionId: string;
    tenantId: string;
    now: Date;
  }): Promise<NonNullable<FakeRepository['connection']>> {
    const candidate = this.pending?.candidateTenants.find(
      (value) =>
        value.connectionId === input.connectionId &&
        value.tenantId === input.tenantId
    );
    if (candidate === undefined) {
      return Promise.reject(new Error('XERO_TENANT_ALREADY_CONNECTED'));
    }
    this.connection = {
      organisationId: input.organisationId,
      connectionId: input.connectionId,
      tenantId: input.tenantId,
      status: 'CONNECTED',
      encryptedRefreshToken: this.pending?.encryptedRefreshToken ?? null,
      grantedScopes: this.pending?.grantedScopes ?? [],
      refreshTokenVersion: 1,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    };
    this.pending = undefined;
    return Promise.resolve(this.connection);
  }

  findByOrganisationId(
    organisationId: string
  ): Promise<FakeRepository['connection']> {
    return Promise.resolve(
      this.connection?.organisationId === organisationId
        ? this.connection
        : null
    );
  }

  disconnect(organisationId: string): Promise<NonNullable<FakeRepository['connection']>> {
    if (this.connection?.organisationId !== organisationId) {
      return Promise.reject(new Error('XERO_CONNECTION_NOT_FOUND'));
    }
    this.connection = {
      ...this.connection,
      status: 'DISCONNECTED',
      encryptedRefreshToken: null,
      grantedScopes: []
    };
    return Promise.resolve(this.connection);
  }
}

const oauthTokens: XeroOAuthTokens = {
  accessToken: 'short-lived-access-token',
  refreshToken: 'rotating-refresh-token',
  expiresInSeconds: 1800,
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'accounting.invoices',
    'accounting.contacts.read',
    'accounting.settings.read'
  ]
};

const candidate = (id: string, tenantId: string): XeroOAuthConnection => ({
  id,
  tenantId,
  tenantType: 'ORGANISATION',
  tenantName: `Tenant ${tenantId}`,
  createdDateUtc: '2026-11-09T00:00:00Z',
  updatedDateUtc: '2026-11-09T00:00:00Z'
});

const dependencies = (
  repository: FakeRepository,
  candidates: XeroOAuthConnection[]
): XeroOAuthServiceDependencies & {
  cipher: FakeCipher;
  audits: XeroOAuthAuditEvent[];
  deleted: string[];
} => {
  const cipher = new FakeCipher();
  const audits: XeroOAuthAuditEvent[] = [];
  const deleted: string[] = [];
  return {
    repository,
    cipher,
    audits,
    deleted,
    tokenCipher: cipher,
    oauth: {
      createAuthorizationUrl: (state) =>
        `https://identity.xero.test/connect/authorize?state=${encodeURIComponent(state)}&scope=openid+offline_access`,
      exchangeAuthorizationCode: () => Promise.resolve(oauthTokens),
      listConnections: () => Promise.resolve(candidates),
      deleteConnection: (_accessToken, connectionId) => {
        deleted.push(connectionId);
        return Promise.resolve();
      }
    },
    sessionForOrganisation: () =>
      Promise.resolve<XeroAuthorisedSession>({
        accessToken: 'disconnect-access-token',
        tenantId: 'tenant-one'
      }),
    audit: (event) => {
      audits.push(event);
      return Promise.resolve();
    },
    clock: { now: () => new Date('2026-11-09T00:00:00.000Z') },
    randomState: () => 'fixed-random-state'
  };
};

describe('Xero OAuth service', () => {
  it('starts a new Solo authorization bound to the provisional identity', async () => {
    const repository = new FakeRepository();
    const service = createXeroOAuthService(dependencies(repository, []));

    const result = await service.startSoloConnection(provisionalSession);

    expect(result.authorizationUrl).toContain('identity.xero.test');
    expect(repository.transaction).toMatchObject({
      userId: 'solo-owner-user',
      existingOrganisationId: null,
      flowPurpose: 'NEW_SOLO',
      returnPath: '/onboarding'
    });
  });

  it('enriches one Xero tenant and provisions the Solo workspace immediately', async () => {
    const repository = new FakeRepository();
    const configured = dependencies(repository, [
      candidate('connection-solo', 'tenant-solo')
    ]);
    const provisioned: Array<Record<string, string>> = [];
    configured.organisationForTenant = () =>
      Promise.resolve({
        id: 'xero-organisation-solo',
        name: 'Solo Repairs Pty Ltd',
        baseCurrency: 'AUD',
        timeZone: 'AUSEASTERNSTANDARDTIME'
      });
    configured.provisionSolo = (_session, input) => {
      provisioned.push(input);
      return Promise.resolve({
        organisationId: 'org_solo',
        created: true,
        initialSyncQueued: true
      });
    };
    const service = createXeroOAuthService(configured);
    const started = await service.startSoloConnection(provisionalSession);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');

    await expect(
      service.handleCallback(provisionalSession, {
        state,
        code: 'authorization-code',
        error: null
      })
    ).resolves.toEqual({
      kind: 'CONNECTED',
      organisationId: 'org_solo',
      returnPath: '/onboarding?sync=queued'
    });
    expect(repository.pending?.candidateTenants).toEqual([
      expect.objectContaining({
        connectionId: 'connection-solo',
        tenantId: 'tenant-solo',
        xeroOrganisationId: 'xero-organisation-solo',
        organisationName: 'Solo Repairs Pty Ltd',
        baseCurrency: 'AUD',
        timeZone: 'Australia/Sydney'
      })
    ]);
    expect(provisioned).toEqual([
      {
        pendingAuthorisationId: 'pending-id',
        connectionId: 'connection-solo',
        tenantId: 'tenant-solo'
      }
    ]);
  });

  it('returns safe Solo tenant choices before provisioning the selected tenant', async () => {
    const repository = new FakeRepository();
    const configured = dependencies(repository, [
      candidate('connection-one', 'tenant-one'),
      candidate('connection-two', 'tenant-two')
    ]);
    configured.organisationForTenant = (_token, tenantId) =>
      Promise.resolve({
        id: `xero-${tenantId}`,
        name: `Organisation ${tenantId}`,
        baseCurrency: tenantId === 'tenant-one' ? 'AUD' : 'NZD',
        timeZone:
          tenantId === 'tenant-one'
            ? 'AUSEASTERNSTANDARDTIME'
            : 'NEWZEALANDSTANDARDTIME'
      });
    configured.provisionSolo = (_session, input) =>
      Promise.resolve({
        organisationId: `org-${input.tenantId}`,
        created: true,
        initialSyncQueued: true
      });
    const service = createXeroOAuthService(configured);
    const started = await service.startSoloConnection(provisionalSession);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');

    await expect(
      service.handleCallback(provisionalSession, {
        state,
        code: 'authorization-code',
        error: null
      })
    ).resolves.toEqual({
      kind: 'SELECT_SOLO_TENANT',
      pendingAuthorisationId: 'pending-id'
    });
    await expect(
      service.getSoloTenantSelection(provisionalSession, 'pending-id')
    ).resolves.toEqual({
      candidates: [
        {
          connectionId: 'connection-one',
          tenantId: 'tenant-one',
          tenantName: 'Organisation tenant-one'
        },
        {
          connectionId: 'connection-two',
          tenantId: 'tenant-two',
          tenantName: 'Organisation tenant-two'
        }
      ]
    });
    await expect(
      service.selectSoloTenant(provisionalSession, {
        pendingAuthorisationId: 'pending-id',
        connectionId: 'connection-two',
        tenantId: 'tenant-two'
      })
    ).resolves.toMatchObject({ organisationId: 'org-tenant-two' });
  });

  it('stores only a state hash bound to the active Admin and organisation', async () => {
    const repository = new FakeRepository();
    const service = createXeroOAuthService(dependencies(repository, []));

    const result = await service.startConnection(adminSession, {
      organisationId: 'organisation-one',
      returnPath: '/settings/integrations'
    });

    const state = new URL(result.authorizationUrl).searchParams.get('state');
    expect(state).not.toBeNull();
    expect(repository.transaction).toMatchObject({
      userId: 'admin-user',
      existingOrganisationId: 'organisation-one',
      flowPurpose: 'CONNECT_EXISTING',
      returnPath: '/settings/integrations'
    });
    expect(repository.transaction?.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repository.transaction?.stateHash).not.toContain('fixed-random-state');
    expect(JSON.stringify(repository.transaction)).not.toContain(state);
  });

  it('rejects Operator connect, selection and disconnect attempts', async () => {
    const repository = new FakeRepository();
    const service = createXeroOAuthService(
      dependencies(repository, [candidate('connection-one', 'tenant-one')])
    );

    await expect(
      service.startConnection(operatorSession, {
        organisationId: 'organisation-one',
        returnPath: '/settings/integrations'
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      service.selectTenant(operatorSession, {
        organisationId: 'organisation-one',
        pendingAuthorisationId: 'pending-id',
        connectionId: 'connection-one',
        tenantId: 'tenant-one'
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      service.disconnect(operatorSession, 'organisation-one')
    ).rejects.toThrow('FORBIDDEN');
  });

  it('finalises one tenant immediately without persisting the access token', async () => {
    const repository = new FakeRepository();
    const configured = dependencies(repository, [
      candidate('connection-one', 'tenant-one')
    ]);
    const service = createXeroOAuthService(configured);
    const started = await service.startConnection(adminSession, {
      organisationId: 'organisation-one',
      returnPath: '/settings/integrations'
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');

    await expect(
      service.handleCallback(adminSession, {
        state,
        code: 'authorization-code',
        error: null
      })
    ).resolves.toMatchObject({ kind: 'CONNECTED', organisationId: 'organisation-one' });
    expect(configured.cipher.plaintexts).toEqual(['rotating-refresh-token']);
    expect(JSON.stringify(repository)).not.toContain('short-lived-access-token');
    expect(configured.audits.map((event) => event.eventType)).toContain(
      'XERO_CONNECTED'
    );
  });

  it('stores a short-lived encrypted pending record for multiple tenants and returns safe choices', async () => {
    const repository = new FakeRepository();
    const configured = dependencies(repository, [
      candidate('connection-one', 'tenant-one'),
      candidate('connection-two', 'tenant-two')
    ]);
    const service = createXeroOAuthService(configured);
    const started = await service.startConnection(adminSession, {
      organisationId: 'organisation-one',
      returnPath: '/settings/integrations'
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');

    const callback = await service.handleCallback(adminSession, {
      state,
      code: 'authorization-code',
      error: null
    });
    expect(callback).toEqual({
      kind: 'SELECT_TENANT',
      organisationId: 'organisation-one',
      pendingAuthorisationId: 'pending-id'
    });
    const view = await service.getTenantSelection(adminSession, {
      organisationId: 'organisation-one',
      pendingAuthorisationId: 'pending-id'
    });
    expect(view.candidates).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain('rotating-refresh-token');
    expect(JSON.stringify(view)).not.toContain('ciphertext');
  });

  it('is idempotent for a repeated consumed callback once the same organisation is connected', async () => {
    const repository = new FakeRepository();
    const configured = dependencies(repository, [
      candidate('connection-one', 'tenant-one')
    ]);
    const service = createXeroOAuthService(configured);
    const started = await service.startConnection(adminSession, {
      organisationId: 'organisation-one',
      returnPath: '/settings/integrations'
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');
    const input = { state, code: 'authorization-code', error: null };

    await service.handleCallback(adminSession, input);
    await expect(service.handleCallback(adminSession, input)).resolves.toMatchObject({
      kind: 'CONNECTED',
      organisationId: 'organisation-one'
    });
  });

  it('does not treat another Admin replaying a consumed callback as idempotent', async () => {
    const repository = new FakeRepository();
    const configured = dependencies(repository, [
      candidate('connection-one', 'tenant-one')
    ]);
    const service = createXeroOAuthService(configured);
    const started = await service.startConnection(adminSession, {
      organisationId: 'organisation-one',
      returnPath: '/settings/integrations'
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');
    const input = { state, code: 'authorization-code', error: null };
    await service.handleCallback(adminSession, input);

    await expect(
      service.handleCallback(secondAdminSession, input)
    ).rejects.toThrow('XERO_OAUTH_STATE_INVALID');
  });

  it('rejects consent denial and an authorization with no Xero tenants', async () => {
    const repository = new FakeRepository();
    const service = createXeroOAuthService(dependencies(repository, []));
    const started = await service.startConnection(adminSession, {
      organisationId: 'organisation-one',
      returnPath: '/settings/integrations'
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');

    await expect(
      service.handleCallback(adminSession, {
        state,
        code: null,
        error: 'access_denied'
      })
    ).rejects.toThrow('XERO_CONSENT_DENIED');
    const restarted = await service.startConnection(adminSession, {
      organisationId: 'organisation-one',
      returnPath: '/settings/integrations'
    });
    const restartedState = new URL(
      restarted.authorizationUrl
    ).searchParams.get('state');
    if (restartedState === null) throw new Error('state missing');
    await expect(
      service.handleCallback(adminSession, {
        state: restartedState,
        code: 'authorization-code',
        error: null
      })
    ).rejects.toThrow('XERO_NO_TENANTS');
  });

  it('revokes the exact remote connection before clearing local token material', async () => {
    const repository = new FakeRepository();
    const configured = dependencies(repository, []);
    repository.connection = {
      organisationId: 'organisation-one',
      connectionId: 'connection-one',
      tenantId: 'tenant-one',
      status: 'CONNECTED',
      encryptedRefreshToken: envelope('refresh-token'),
      grantedScopes: ['offline_access'],
      refreshTokenVersion: 1,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    };
    const service = createXeroOAuthService(configured);

    await service.disconnect(adminSession, 'organisation-one');

    expect(configured.deleted).toEqual(['connection-one']);
    expect(repository.connection.status).toBe('DISCONNECTED');
    expect(configured.audits.map((event) => event.eventType)).toContain(
      'XERO_DISCONNECTED'
    );
  });
});
