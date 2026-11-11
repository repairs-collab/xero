import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { organisations, users } from '../schema/index.js';
import {
  PostgresXeroConnectionRepository,
  type XeroConnectionRecord
} from './xero-connection-repository.js';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000';
const firstClient = createDatabase(databaseUrl);
const secondClient = createDatabase(databaseUrl);
const firstRepository = new PostgresXeroConnectionRepository(firstClient.db);
const secondRepository = new PostgresXeroConnectionRepository(secondClient.db);

const envelope = (ciphertext: string) => ({
  version: 1,
  keyId: 'primary',
  iv: Buffer.alloc(12, 1).toString('base64'),
  ciphertext: Buffer.from(ciphertext).toString('base64'),
  tag: Buffer.alloc(16, 2).toString('base64')
});

const seedUser = async (label: string): Promise<string> => {
  const id = randomUUID();
  await firstClient.db.insert(users).values({
    id,
    cognitoSubject: randomUUID(),
    email: `${id}@example.invalid`,
    displayName: label
  });
  return id;
};

const seedOrganisation = async (label: string): Promise<string> => {
  const id = randomUUID();
  await firstClient.db.insert(organisations).values({
    id,
    xeroOrganisationId: randomUUID(),
    name: label,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  return id;
};

beforeAll(() => migrateDatabase(firstClient.db));
afterAll(async () => {
  await Promise.all([firstClient.pool.end(), secondClient.pool.end()]);
});

describe('PostgresXeroConnectionRepository', () => {
  it('creates and consumes a hashed OAuth transaction exactly once with all bindings', async () => {
    const userId = await seedUser('OAuth owner');
    const wrongUserId = await seedUser('Wrong OAuth owner');
    const organisationId = await seedOrganisation('OAuth transaction organisation');
    const wrongOrganisationId = await seedOrganisation('Wrong OAuth organisation');
    const stateHash = createHash('sha256').update(randomUUID()).digest('hex');
    const now = new Date('2026-11-09T01:00:00.000Z');

    await firstRepository.createOAuthTransaction({
      stateHash,
      userId,
      existingOrganisationId: organisationId,
      flowPurpose: 'CONNECT_EXISTING',
      returnPath: '/settings/integrations',
      expiresAt: new Date(now.getTime() + 300_000)
    });

    await expect(
      firstRepository.consumeOAuthTransaction({
        stateHash,
        userId: wrongUserId,
        existingOrganisationId: organisationId,
        now
      })
    ).rejects.toThrow('XERO_OAUTH_TRANSACTION_INVALID');
    await expect(
      firstRepository.consumeOAuthTransaction({
        stateHash,
        userId,
        existingOrganisationId: wrongOrganisationId,
        now
      })
    ).rejects.toThrow('XERO_OAUTH_TRANSACTION_INVALID');

    await expect(
      firstRepository.consumeOAuthTransaction({
        stateHash,
        userId,
        existingOrganisationId: organisationId,
        now
      })
    ).resolves.toMatchObject({
      stateHash,
      userId,
      existingOrganisationId: organisationId,
      flowPurpose: 'CONNECT_EXISTING'
    });
    await expect(
      firstRepository.consumeOAuthTransaction({
        stateHash,
        userId,
        existingOrganisationId: organisationId,
        now
      })
    ).rejects.toThrow('XERO_OAUTH_TRANSACTION_INVALID');

    const expiredHash = createHash('sha256').update(randomUUID()).digest('hex');
    await firstRepository.createOAuthTransaction({
      stateHash: expiredHash,
      userId,
      existingOrganisationId: null,
      flowPurpose: 'NEW_SOLO',
      returnPath: '/onboarding',
      expiresAt: new Date(now.getTime() - 1)
    });
    await expect(
      firstRepository.consumeOAuthTransaction({
        stateHash: expiredHash,
        userId,
        existingOrganisationId: null,
        now
      })
    ).rejects.toThrow('XERO_OAUTH_TRANSACTION_INVALID');
  });

  it('finalises a pending tenant idempotently and rejects cross-organisation ownership', async () => {
    const userId = await seedUser('Pending OAuth owner');
    const firstOrganisationId = await seedOrganisation('First pending organisation');
    const secondOrganisationId = await seedOrganisation('Second pending organisation');
    const now = new Date('2026-11-09T02:00:00.000Z');
    const candidate = {
      connectionId: randomUUID(),
      tenantId: randomUUID(),
      tenantName: 'Example Pty Ltd',
      tenantType: 'ORGANISATION',
      xeroOrganisationId: 'xero-example-organisation',
      organisationName: 'Example Pty Ltd',
      baseCurrency: 'AUD',
      timeZone: 'Australia/Sydney'
    };
    const pendingId = await firstRepository.createPendingAuthorisation({
      userId,
      existingOrganisationId: firstOrganisationId,
      flowPurpose: 'CONNECT_EXISTING',
      encryptedRefreshToken: envelope('first-refresh-token'),
      candidateTenants: [candidate],
      grantedScopes: ['openid', 'offline_access', 'accounting.invoices'],
      expiresAt: new Date(now.getTime() + 300_000)
    });

    const finalise = () =>
      firstRepository.finalisePendingAuthorisation({
        pendingAuthorisationId: pendingId,
        userId,
        existingOrganisationId: firstOrganisationId,
        organisationId: firstOrganisationId,
        connectionId: candidate.connectionId,
        tenantId: candidate.tenantId,
        now
      });

    const first = await finalise();
    const [updatedOrganisation] = await firstClient.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, firstOrganisationId));
    expect(updatedOrganisation).toMatchObject({
      xeroOrganisationId: 'xero-example-organisation',
      name: 'Example Pty Ltd',
      baseCurrency: 'AUD',
      timeZone: 'Australia/Sydney'
    });
    await expect(finalise()).resolves.toEqual(first);
    await expect(
      firstRepository.findPendingAuthorisation({
        pendingAuthorisationId: pendingId,
        userId,
        existingOrganisationId: firstOrganisationId,
        now
      })
    ).resolves.toBeNull();

    const conflictingPendingId = await firstRepository.createPendingAuthorisation({
      userId,
      existingOrganisationId: secondOrganisationId,
      flowPurpose: 'CONNECT_EXISTING',
      encryptedRefreshToken: envelope('second-refresh-token'),
      candidateTenants: [candidate],
      grantedScopes: ['openid', 'offline_access', 'accounting.invoices'],
      expiresAt: new Date(now.getTime() + 300_000)
    });
    await expect(
      firstRepository.finalisePendingAuthorisation({
        pendingAuthorisationId: conflictingPendingId,
        userId,
        existingOrganisationId: secondOrganisationId,
        organisationId: secondOrganisationId,
        connectionId: candidate.connectionId,
        tenantId: candidate.tenantId,
        now
      })
    ).rejects.toThrow('XERO_TENANT_ALREADY_CONNECTED');
  });

  it('finds, marks, disconnects and reconnects without decrypting token material', async () => {
    const organisationId = await seedOrganisation('Connection lifecycle');
    const connectionId = randomUUID();
    const tenantId = randomUUID();
    const now = new Date('2026-11-09T03:00:00.000Z');

    await firstRepository.upsertConnection({
      organisationId,
      connectionId,
      tenantId,
      encryptedRefreshToken: envelope('original-refresh-token'),
      grantedScopes: ['openid', 'offline_access'],
      now
    });
    const storedConnection = await firstRepository.findByOrganisationId(organisationId);
    expect(storedConnection).toMatchObject({
      organisationId,
      connectionId,
      tenantId,
      status: 'CONNECTED'
    });
    expect(storedConnection?.encryptedRefreshToken?.ciphertext).toBeTypeOf('string');
    await expect(firstRepository.findOrganisationIdByTenantId(tenantId)).resolves.toBe(
      organisationId
    );

    await firstRepository.markReauthRequired(organisationId, now);
    await expect(firstRepository.findByOrganisationId(organisationId)).resolves.toMatchObject({
      status: 'REAUTH_REQUIRED'
    });
    await firstRepository.disconnect(organisationId, now);
    await expect(firstRepository.findByOrganisationId(organisationId)).resolves.toMatchObject({
      status: 'DISCONNECTED',
      encryptedRefreshToken: null,
      grantedScopes: []
    });

    await firstRepository.upsertConnection({
      organisationId,
      connectionId,
      tenantId,
      encryptedRefreshToken: envelope('reconnected-refresh-token'),
      grantedScopes: ['openid', 'offline_access'],
      now: new Date(now.getTime() + 1_000)
    });
    await expect(firstRepository.findByOrganisationId(organisationId)).resolves.toMatchObject({
      status: 'CONNECTED',
      refreshTokenVersion: 2,
      disconnectedAt: null
    });
  });

  it('serialises refresh leases across independent database clients', async () => {
    const organisationId = await seedOrganisation('Refresh lease concurrency');
    const now = new Date('2026-11-09T04:00:00.000Z');
    await firstRepository.upsertConnection({
      organisationId,
      connectionId: randomUUID(),
      tenantId: randomUUID(),
      encryptedRefreshToken: envelope('lease-refresh-token'),
      grantedScopes: ['openid', 'offline_access'],
      now
    });
    const firstLeaseId = randomUUID();
    const secondLeaseId = randomUUID();

    const leases = await Promise.all([
      firstRepository.acquireRefreshLease({
        organisationId,
        leaseId: firstLeaseId,
        now,
        expiresAt: new Date(now.getTime() + 30_000)
      }),
      secondRepository.acquireRefreshLease({
        organisationId,
        leaseId: secondLeaseId,
        now,
        expiresAt: new Date(now.getTime() + 30_000)
      })
    ]);
    expect(leases.filter((lease): lease is XeroConnectionRecord => lease !== null)).toHaveLength(1);
    const winningLeaseId = leases[0] === null ? secondLeaseId : firstLeaseId;
    const losingLeaseId = winningLeaseId === firstLeaseId ? secondLeaseId : firstLeaseId;

    await expect(
      firstRepository.completeRefreshLease({
        organisationId,
        leaseId: losingLeaseId,
        encryptedRefreshToken: envelope('wrong-owner-token'),
        grantedScopes: ['openid', 'offline_access'],
        now
      })
    ).rejects.toThrow('XERO_REFRESH_LEASE_NOT_OWNED');
    await expect(
      firstRepository.completeRefreshLease({
        organisationId,
        leaseId: winningLeaseId,
        encryptedRefreshToken: envelope('rotated-refresh-token'),
        grantedScopes: ['openid', 'offline_access'],
        now
      })
    ).resolves.toMatchObject({ refreshTokenVersion: 2, refreshLeaseId: null });
    await expect(
      secondRepository.releaseRefreshLease(organisationId, losingLeaseId, now)
    ).resolves.toBe(false);
  });
});
