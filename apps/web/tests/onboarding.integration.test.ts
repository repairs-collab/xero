import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  createDatabase,
  memberships,
  migrateDatabase,
  organisationOnboarding,
  organisations,
  outboundMessages,
  reminderSequences,
  subscriptions,
  users,
  xeroConnections
} from '@bc5000/db';

import {
  createOnboardingService,
  createPostgresOnboardingRepository
} from '../src/app/onboarding/onboarding-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-10T00:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const seedReadySolo = async (): Promise<{
  organisationId: string;
  session: AppSession;
}> => {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const cognitoSubject = randomUUID();
  const syncAt = new Date('2026-11-09T23:55:00.000Z');
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Ready Solo',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO',
    operationalState: 'RECONCILED',
    lastSuccessfulSyncAt: syncAt,
    latestReconciledSyncAt: syncAt
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject,
    email: `${userId}@example.invalid`,
    displayName: 'Ready Administrator'
  });
  await client.db.insert(memberships).values({
    organisationId,
    userId,
    role: 'ADMIN'
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: 'ACTIVE',
    currentPeriodStart: now,
    currentPeriodEnd: new Date('2026-12-10T00:00:00.000Z')
  });
  await client.db.insert(organisationOnboarding).values({
    organisationId,
    version: 1,
    xeroConnectedAt: now,
    businessDetailsCompletedAt: now,
    adminMobileVerifiedAt: now,
    sequenceReviewedAt: now
  });
  await client.db.insert(xeroConnections).values({
    organisationId,
    connectionId: randomUUID(),
    tenantId: randomUUID(),
    status: 'CONNECTED',
    encryptedRefreshToken: {
      version: 1,
      keyId: 'test',
      iv: Buffer.alloc(12).toString('base64'),
      ciphertext: Buffer.from('encrypted').toString('base64'),
      tag: Buffer.alloc(16).toString('base64')
    },
    grantedScopes: ['offline_access', 'accounting.invoices']
  });
  await client.db.insert(reminderSequences).values({
    organisationId,
    name: 'Reviewed sequence',
    mode: 'REVIEW'
  });
  await client.db.insert(outboundMessages).values({
    organisationId,
    actorUserId: userId,
    channel: 'SMS',
    source: 'TEST_SMS',
    recipientKey: '+61412345678',
    content: 'Test',
    status: 'ACCEPTED',
    idempotencyKey: randomUUID()
  });
  return {
    organisationId,
    session: {
      userId,
      cognitoSubject,
      displayName: 'Ready Administrator',
      expiresAt: '2026-11-11T00:00:00.000Z',
      memberships: [{ organisationId, role: 'ADMIN', active: true }]
    }
  };
};

describe('guided Solo onboarding persistence', () => {
  it('completes only from evidence and records versioned completion idempotently', async () => {
    const seeded = await seedReadySolo();
    const service = createOnboardingService({
      repository: createPostgresOnboardingRepository(client.db, {
        verifiedAdminMobile: () =>
          Promise.resolve({ number: '+61412345678', verifiedAt: now }),
        replyNumberStatus: () => Promise.resolve('READY')
      }),
      clock: { now: () => now }
    });

    await expect(
      service.getStatus(seeded.session, seeded.organisationId)
    ).resolves.toMatchObject({ completedCount: 8, complete: true });
    await expect(
      service.getStatus(seeded.session, seeded.organisationId)
    ).resolves.toMatchObject({ complete: true });

    const [stored] = await client.db
      .select()
      .from(organisationOnboarding)
      .where(
        eq(organisationOnboarding.organisationId, seeded.organisationId)
      );
    expect(stored).toMatchObject({
      completedVersion: 1,
      completedAt: now
    });
  });

  it('does not accept another tenant membership as access', async () => {
    const seeded = await seedReadySolo();
    const service = createOnboardingService({
      repository: createPostgresOnboardingRepository(client.db),
      clock: { now: () => now }
    });
    const foreignSession: AppSession = {
      ...seeded.session,
      memberships: [
        { organisationId: randomUUID(), role: 'ADMIN', active: true }
      ]
    };

    await expect(
      service.getStatus(foreignSession, seeded.organisationId)
    ).rejects.toThrow('FORBIDDEN');
  });
});
