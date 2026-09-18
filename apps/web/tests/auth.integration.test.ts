import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clearSessionCookie,
  createSessionCookie,
  requireSession
} from '@bc5000/auth';
import {
  createDatabase,
  memberships,
  migrateDatabase,
  organisations,
  users
} from '@bc5000/db';

import { evaluateProxyAccess } from '../src/proxy-policy.js';
import { PostgresMembershipLoader } from '../src/server/membership-loader.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const secret = new Uint8Array(32).fill(9);
const now = new Date('2026-09-18T00:00:00.000Z');

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

describe('web authentication boundary', () => {
  it('allows only explicit public endpoints without a session cookie', () => {
    expect(evaluateProxyAccess('/api/webhooks/xero', false)).toBe('allow');
    expect(evaluateProxyAccess('/api/webhooks/sinch', false)).toBe('allow');
    expect(evaluateProxyAccess('/auth/callback', false)).toBe('allow');
    expect(evaluateProxyAccess('/health/live', false)).toBe('allow');
    expect(evaluateProxyAccess('/approvals', false)).toBe('login');
    expect(evaluateProxyAccess('/api/admin/users', false)).toBe('login');
    expect(evaluateProxyAccess('/approvals', true)).toBe('allow');
  });

  it('reloads active membership on every protected request', async () => {
    const organisationId = randomUUID();
    const userId = randomUUID();
    const subject = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      name: 'Auth Boundary Organisation',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(users).values({
      id: userId,
      cognitoSubject: subject,
      email: `auth-${userId}@example.invalid`,
      displayName: 'Auth Test User'
    });
    await client.db.insert(memberships).values({
      organisationId,
      userId,
      role: 'OPERATOR'
    });
    const cookie = await createSessionCookie(
      { cognitoSubject: subject },
      { secret, now }
    );
    const request = new Request('https://bill-chaser.test/approvals', {
      headers: { cookie: cookie.split(';')[0] ?? '' }
    });
    const loader = new PostgresMembershipLoader(client.db);

    await expect(
      requireSession(request, {
        secret,
        now: new Date(now.getTime() + 1000),
        memberships: loader
      })
    ).resolves.toMatchObject({ userId });

    await client.db
      .update(memberships)
      .set({ disabledAt: new Date(now.getTime() + 2000) })
      .where(
        and(
          eq(memberships.organisationId, organisationId),
          eq(memberships.userId, userId)
        )
      );
    await expect(
      requireSession(request, {
        secret,
        now: new Date(now.getTime() + 3000),
        memberships: loader
      })
    ).rejects.toThrow('UNAUTHENTICATED');
  });

  it('clears the application cookie on logout', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});
