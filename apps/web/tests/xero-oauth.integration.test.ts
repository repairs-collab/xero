import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  organisations,
  PostgresXeroConnectionRepository,
  users
} from '@bc5000/db';
import type {
  TokenCipher,
  XeroOAuthConnection,
  XeroOAuthTokens
} from '@bc5000/integrations/xero';

import { createXeroOAuthService } from '../src/server/xero-oauth-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-09T02:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const cipher: TokenCipher = {
  encrypt: (plaintext) => ({
    version: 1,
    keyId: 'test',
    iv: Buffer.alloc(12).toString('base64'),
    ciphertext: Buffer.from(plaintext).toString('base64'),
    tag: Buffer.alloc(16).toString('base64')
  }),
  decrypt: (value) => Buffer.from(value.ciphertext, 'base64').toString('utf8')
};

const tokens: XeroOAuthTokens = {
  accessToken: 'memory-only-access-token',
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
  createdDateUtc: now.toISOString(),
  updatedDateUtc: now.toISOString()
});

async function seed() {
  const organisationId = randomUUID();
  const userId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'OAuth integration organisation',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'OAuth Admin'
  });
  const session: AppSession = {
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'OAuth Admin',
    expiresAt: '2026-11-10T00:00:00.000Z',
    memberships: [
      { organisationId, role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }
    ]
  };
  return { organisationId, session };
}

function serviceFor(
  repository: PostgresXeroConnectionRepository,
  candidates: XeroOAuthConnection[]
) {
  return createXeroOAuthService({
    repository,
    tokenCipher: cipher,
    oauth: {
      createAuthorizationUrl: (state) =>
        `https://identity.xero.test/connect/authorize?state=${encodeURIComponent(state)}`,
      exchangeAuthorizationCode: () => Promise.resolve(tokens),
      listConnections: () => Promise.resolve(candidates),
      deleteConnection: () => Promise.resolve()
    },
    sessionForOrganisation: () =>
      Promise.resolve({ accessToken: 'memory-only-access-token', tenantId: null }),
    audit: async (event) => {
      await client.db.insert(auditEvents).values({
        organisationId: event.organisationId,
        actorUserId: event.actorUserId,
        eventType: event.eventType,
        entityType: 'XERO_CONNECTION',
        entityId: event.entityId,
        afterValue: event.afterValue,
        occurredAt: event.occurredAt
      });
    },
    clock: { now: () => now },
    randomState: () => randomUUID()
  });
}

describe('Xero customer OAuth', () => {
  it('binds state to the Admin and organisation, then stores only the encrypted refresh token', async () => {
    const seeded = await seed();
    const repository = new PostgresXeroConnectionRepository(client.db);
    const selected = candidate(randomUUID(), randomUUID());
    const service = serviceFor(repository, [selected]);
    const started = await service.startConnection(seeded.session, {
      organisationId: seeded.organisationId,
      returnPath: '/settings/integrations'
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');

    await expect(
      service.handleCallback(seeded.session, {
        state,
        code: 'authorization-code',
        error: null
      })
    ).resolves.toMatchObject({
      kind: 'CONNECTED',
      organisationId: seeded.organisationId
    });
    const stored = await repository.findByOrganisationId(seeded.organisationId);
    expect(stored).toMatchObject({
      connectionId: selected.id,
      tenantId: selected.tenantId,
      status: 'CONNECTED'
    });
    expect(JSON.stringify(stored)).not.toContain('memory-only-access-token');
    expect(JSON.stringify(stored)).not.toContain('rotating-refresh-token');
  });

  it('rejects callback replay by another user and prevents cross-organisation tenant ownership', async () => {
    const first = await seed();
    const second = await seed();
    const repository = new PostgresXeroConnectionRepository(client.db);
    const selected = candidate(randomUUID(), randomUUID());
    const firstService = serviceFor(repository, [selected]);
    const started = await firstService.startConnection(first.session, {
      organisationId: first.organisationId,
      returnPath: '/settings/integrations'
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('state missing');
    await expect(
      firstService.handleCallback(second.session, {
        state,
        code: 'authorization-code',
        error: null
      })
    ).rejects.toThrow('XERO_OAUTH_STATE_INVALID');
  });
});
