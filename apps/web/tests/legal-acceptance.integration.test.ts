import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  migrateDatabase,
  userLegalAcceptances,
  users
} from '@bc5000/db';

import {
  currentLegalVersions,
  hasCurrentLegalAcceptance,
  recordCurrentLegalAcceptance
} from '../src/server/legal-acceptance.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

describe('legal acceptance', () => {
  it('rejects the previous Terms version while retaining unchanged document versions', async () => {
    const userId = randomUUID();
    await client.db.insert(users).values({
      id: userId,
      cognitoSubject: randomUUID(),
      email: `${userId}@example.invalid`,
      displayName: 'Previous Terms Customer'
    });
    await client.db.insert(userLegalAcceptances).values({
      userId,
      termsVersion: '2026-11-11',
      privacyVersion: '2026-11-11',
      acceptableUseVersion: '2026-11-11',
      acceptedAt: new Date('2026-11-11T01:00:00.000Z')
    });

    expect(currentLegalVersions.privacy).toBe('2026-11-11');
    expect(currentLegalVersions.acceptableUse).toBe('2026-11-11');
    await expect(hasCurrentLegalAcceptance(client.db, userId)).resolves.toBe(
      false
    );
  });

  it('blocks a customer until every current document version is accepted', async () => {
    const userId = randomUUID();
    await client.db.insert(users).values({
      id: userId,
      cognitoSubject: randomUUID(),
      email: `${userId}@example.invalid`,
      displayName: 'Legal Acceptance Customer'
    });

    await expect(
      hasCurrentLegalAcceptance(client.db, userId)
    ).resolves.toBe(false);
    await recordCurrentLegalAcceptance(client.db, {
      userId,
      acceptedAt: new Date('2026-11-11T01:00:00.000Z')
    });
    await expect(
      hasCurrentLegalAcceptance(client.db, userId)
    ).resolves.toBe(true);

    const rows = await client.db.select().from(userLegalAcceptances);
    expect(rows.find((row) => row.userId === userId)).toMatchObject({
      termsVersion: currentLegalVersions.terms,
      privacyVersion: currentLegalVersions.privacy,
      acceptableUseVersion: currentLegalVersions.acceptableUse
    });
  });

  it('does not interrupt the platform owner console', async () => {
    const userId = randomUUID();
    await client.db.insert(users).values({
      id: userId,
      cognitoSubject: randomUUID(),
      email: `${userId}@example.invalid`,
      displayName: 'Platform Owner',
      platformRole: 'OWNER'
    });

    await expect(
      hasCurrentLegalAcceptance(client.db, userId)
    ).resolves.toBe(true);
  });
});
