import { randomUUID } from 'node:crypto';

import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  migrateDatabase,
  users,
  xeroOAuthTransactions,
  xeroPendingAuthorisations
} from '@bc5000/db';

import { cleanupExpiredXeroOAuthState } from '../src/handlers/xero-oauth-cleanup.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-10T00:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('Xero OAuth transient-state cleanup', () => {
  it('deletes only consumed or expired transient credentials', async () => {
    const userId = randomUUID();
    const expiredTransactionId = randomUUID();
    const activeTransactionId = randomUUID();
    const expiredPendingId = randomUUID();
    const activePendingId = randomUUID();
    await client.db.insert(users).values({
      id: userId,
      cognitoSubject: randomUUID(),
      email: `${userId}@example.invalid`,
      displayName: 'OAuth cleanup'
    });
    await client.db.insert(xeroOAuthTransactions).values([
      {
        id: expiredTransactionId,
        stateHash: randomUUID().replaceAll('-', '').repeat(2),
        userId,
        flowPurpose: 'NEW_SOLO',
        returnPath: '/onboarding',
        expiresAt: new Date('2026-11-09T23:59:59.000Z')
      },
      {
        id: activeTransactionId,
        stateHash: randomUUID().replaceAll('-', '').repeat(2),
        userId,
        flowPurpose: 'NEW_SOLO',
        returnPath: '/onboarding',
        expiresAt: new Date('2026-11-10T00:10:00.000Z')
      }
    ]);
    const token = {
      version: 1,
      keyId: 'test-key',
      iv: 'iv',
      ciphertext: 'ciphertext',
      tag: 'tag'
    };
    const candidates = [
      {
        connectionId: randomUUID(),
        tenantId: randomUUID(),
        tenantName: 'Test tenant'
      }
    ];
    await client.db.insert(xeroPendingAuthorisations).values([
      {
        id: expiredPendingId,
        userId,
        flowPurpose: 'NEW_SOLO',
        encryptedRefreshToken: token,
        candidateTenants: candidates,
        grantedScopes: ['openid'],
        expiresAt: new Date('2026-11-09T23:59:59.000Z')
      },
      {
        id: activePendingId,
        userId,
        flowPurpose: 'NEW_SOLO',
        encryptedRefreshToken: token,
        candidateTenants: candidates,
        grantedScopes: ['openid'],
        expiresAt: new Date('2026-11-10T00:10:00.000Z')
      }
    ]);

    const cleanup = await cleanupExpiredXeroOAuthState({
      database: client.db,
      clock: { now: () => now }
    });
    expect(cleanup.transactionsDeleted).toBeGreaterThanOrEqual(1);
    expect(cleanup.pendingAuthorisationsDeleted).toBeGreaterThanOrEqual(1);
    expect(
      await client.db
        .select({ id: xeroOAuthTransactions.id })
        .from(xeroOAuthTransactions)
        .where(
          inArray(xeroOAuthTransactions.id, [
            expiredTransactionId,
            activeTransactionId
          ])
        )
    ).toEqual([{ id: activeTransactionId }]);
    expect(
      await client.db
        .select({ id: xeroPendingAuthorisations.id })
        .from(xeroPendingAuthorisations)
        .where(
          inArray(xeroPendingAuthorisations.id, [
            expiredPendingId,
            activePendingId
          ])
        )
    ).toEqual([{ id: activePendingId }]);
  });
});
