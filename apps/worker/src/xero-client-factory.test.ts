import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '@bc5000/integrations/http';
import type {
  EncryptedTokenEnvelope,
  StoredXeroConnection,
  TokenCipher,
  XeroOAuthTokens,
  XeroRefreshTokenStore
} from '@bc5000/integrations/xero';

import { OrganisationXeroClientFactory } from './xero-client-factory.js';

class RecordingHttpClient implements HttpClient {
  requests: HttpRequest[] = [];

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({
        Organisations: [
          {
            OrganisationID: 'organisation-id',
            Name: 'Example Organisation',
            BaseCurrency: 'AUD',
            Timezone: 'AUSEASTERNSTANDARDTIME'
          }
        ]
      })
    });
  }
}

const envelope = (value: string): EncryptedTokenEnvelope => ({
  version: 1,
  keyId: 'test',
  iv: Buffer.alloc(12).toString('base64'),
  ciphertext: Buffer.from(value).toString('base64'),
  tag: Buffer.alloc(16).toString('base64')
});

const cipher: TokenCipher = {
  encrypt: envelope,
  decrypt: (value) => Buffer.from(value.ciphertext, 'base64').toString('utf8')
};

class MemoryStore implements XeroRefreshTokenStore {
  records = new Map<string, StoredXeroConnection>();

  findByOrganisationId(organisationId: string) {
    return Promise.resolve(this.records.get(organisationId) ?? null);
  }

  acquireRefreshLease(input: {
    organisationId: string;
    leaseId: string;
    now: Date;
    expiresAt: Date;
  }) {
    const record = this.records.get(input.organisationId);
    if (record === undefined || record.status !== 'CONNECTED') {
      return Promise.resolve(null);
    }
    const leased = {
      ...record,
      refreshLeaseId: input.leaseId,
      refreshLeaseExpiresAt: input.expiresAt
    };
    this.records.set(input.organisationId, leased);
    return Promise.resolve(leased);
  }

  completeRefreshLease(input: {
    organisationId: string;
    leaseId: string;
    encryptedRefreshToken: EncryptedTokenEnvelope;
    grantedScopes: string[];
    now: Date;
  }) {
    const record = this.records.get(input.organisationId);
    if (record === undefined || record.refreshLeaseId !== input.leaseId) {
      return Promise.reject(new Error('XERO_REFRESH_LEASE_NOT_OWNED'));
    }
    const completed = {
      ...record,
      encryptedRefreshToken: input.encryptedRefreshToken,
      grantedScopes: input.grantedScopes,
      refreshTokenVersion: record.refreshTokenVersion + 1,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    };
    this.records.set(input.organisationId, completed);
    return Promise.resolve(completed);
  }

  releaseRefreshLease(organisationId: string, leaseId: string) {
    const record = this.records.get(organisationId);
    if (record === undefined || record.refreshLeaseId !== leaseId) {
      return Promise.resolve(false);
    }
    this.records.set(organisationId, {
      ...record,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    });
    return Promise.resolve(true);
  }

  markReauthRequired(organisationId: string) {
    const record = this.records.get(organisationId);
    if (record === undefined) {
      return Promise.reject(new Error('XERO_CONNECTION_NOT_FOUND'));
    }
    const updated = {
      ...record,
      status: 'REAUTH_REQUIRED' as const,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null
    };
    this.records.set(organisationId, updated);
    return Promise.resolve(updated);
  }
}

const connected = (organisationId: string, tenantId: string): StoredXeroConnection => ({
  organisationId,
  tenantId,
  status: 'CONNECTED',
  encryptedRefreshToken: envelope(`refresh-${organisationId}`),
  grantedScopes: ['offline_access'],
  refreshTokenVersion: 1,
  refreshLeaseId: null,
  refreshLeaseExpiresAt: null
});

describe('OrganisationXeroClientFactory', () => {
  it('prefers customer OAuth, falls back only for a legacy organisation, and rejects missing connections', async () => {
    const http = new RecordingHttpClient();
    const store = new MemoryStore();
    store.records.set('oauth-org', connected('oauth-org', 'tenant-oauth'));
    const refreshed: string[] = [];
    const factory = new OrganisationXeroClientFactory({
      http,
      connectionStore: store,
      tokenCipher: cipher,
      oauthClient: {
        refreshAccessToken: (refreshToken): Promise<XeroOAuthTokens> => {
          refreshed.push(refreshToken);
          return Promise.resolve({
            accessToken: `access-${refreshToken}`,
            refreshToken: `next-${refreshToken}`,
            expiresInSeconds: 1800,
            scopes: ['offline_access']
          });
        }
      },
      legacyConnectionEnabled: (organisationId) =>
        Promise.resolve(organisationId === 'legacy-org'),
      legacyTokenProvider: {
        getAccessToken: () => Promise.resolve('legacy-access-token')
      }
    });

    await (await factory.forOrganisation('oauth-org')).getOrganisation();
    await (await factory.forOrganisation('legacy-org')).getOrganisation();
    await expect(factory.forOrganisation('missing-org')).rejects.toThrow(
      'XERO_CONNECTION_REQUIRED'
    );

    expect(refreshed).toEqual(['refresh-oauth-org']);
    expect(http.requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer access-refresh-oauth-org',
      'Xero-Tenant-Id': 'tenant-oauth'
    });
    expect(http.requests[1]?.headers).toMatchObject({
      Authorization: 'Bearer legacy-access-token'
    });
    expect(http.requests[1]?.headers).not.toHaveProperty('Xero-Tenant-Id');
  });

  it('keeps concurrent organisations on different refresh-token and tenant records', async () => {
    const http = new RecordingHttpClient();
    const store = new MemoryStore();
    store.records.set('organisation-a', connected('organisation-a', 'tenant-a'));
    store.records.set('organisation-b', connected('organisation-b', 'tenant-b'));
    const refreshed: string[] = [];
    const factory = new OrganisationXeroClientFactory({
      http,
      connectionStore: store,
      tokenCipher: cipher,
      oauthClient: {
        refreshAccessToken: (refreshToken): Promise<XeroOAuthTokens> => {
          refreshed.push(refreshToken);
          return Promise.resolve({
            accessToken: `access-${refreshToken}`,
            refreshToken: `next-${refreshToken}`,
            expiresInSeconds: 1800,
            scopes: ['offline_access']
          });
        }
      },
      legacyConnectionEnabled: () => Promise.resolve(false)
    });

    const [clientA, clientB] = await Promise.all([
      factory.forOrganisation('organisation-a'),
      factory.forOrganisation('organisation-b')
    ]);
    await Promise.all([clientA.getOrganisation(), clientB.getOrganisation()]);

    expect(refreshed.sort()).toEqual([
      'refresh-organisation-a',
      'refresh-organisation-b'
    ]);
    expect(
      http.requests.map((request) => request.headers['Xero-Tenant-Id']).sort()
    ).toEqual(['tenant-a', 'tenant-b']);
  });
});
