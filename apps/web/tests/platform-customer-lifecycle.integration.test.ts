import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { decideAccountEntitlements } from '@bc5000/domain';
import {
  createDatabase,
  memberships,
  migrateDatabase,
  organisationOnboarding,
  organisations,
  smsAllowanceSettings,
  subscriptions,
  users
} from '@bc5000/db';

import { createPlatformCustomerBackupService } from '../src/server/platform-customer-backup.js';
import {
  createPlatformCustomerProvisioningService,
  createPostgresPlatformCustomerProvisioningRepository
} from '../src/server/platform-customer-provisioning.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

const seedOwner = async (): Promise<AppSession> => {
  const userId = randomUUID();
  const cognitoSubject = randomUUID();
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject,
    email: `${userId}@example.invalid`,
    displayName: 'Platform Owner',
    platformRole: 'OWNER'
  });
  return {
    userId,
    cognitoSubject,
    displayName: 'Platform Owner',
    expiresAt: '2026-11-12T00:00:00.000Z',
    memberships: []
  };
};

describe('platform customer lifecycle', () => {
  it('creates every required onboarding record with safe sending defaults', async () => {
    const owner = await seedOwner();
    const inviteMember = vi.fn().mockResolvedValue({
      invitationId: randomUUID(),
      userId: randomUUID()
    });
    const service = createPlatformCustomerProvisioningService({
      verifyOwner: () => Promise.resolve(true),
      repository: createPostgresPlatformCustomerProvisioningRepository(client.db),
      inviteMember,
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    });

    const result = await service.createCustomer(owner, {
      name: 'Lifecycle Test Repairs',
      adminEmail: 'lifecycle-admin@example.invalid',
      adminDisplayName: 'Lifecycle Administrator',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      includedSmsParts: 1_000,
      warningPercent: 80,
      reason: 'Lifecycle integration test'
    });

    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, result.organisationId));
    const [subscription] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, result.organisationId));
    const [onboarding] = await client.db
      .select()
      .from(organisationOnboarding)
      .where(eq(organisationOnboarding.organisationId, result.organisationId));
    const [allowance] = await client.db
      .select()
      .from(smsAllowanceSettings)
      .where(eq(smsAllowanceSettings.organisationId, result.organisationId));

    expect(organisation).toMatchObject({
      edition: 'SOLO',
      sendMode: 'dry-run',
      rolloutScope: 'CONTROLLED',
      operationalState: 'SYNC_REQUIRED',
      liveSendAcknowledged: false
    });
    expect(subscription).toMatchObject({
      status: 'INCOMPLETE',
      trialEndsAt: null
    });
    expect(
      decideAccountEntitlements({
        edition: 'SOLO',
        platformStatus: 'ACTIVE',
        subscriptionStatus: subscription!.status,
        trialEndsAt: subscription!.trialEndsAt,
        onboardingCompletedVersion: 1,
        requiredOnboardingVersion: 1,
        replyNumberReady: true,
        verifiedAdminMobile: '+61412345678',
        acceptedTrialTestSmsParts: 0,
        now: new Date('2026-11-11T00:00:00.000Z')
      })
    ).toMatchObject({
      canCustomerSend: false,
      canAutomaticDispatch: false,
      blocker: 'SUBSCRIPTION_REQUIRED'
    });
    expect(onboarding).toMatchObject({ version: 1 });
    expect(allowance).toMatchObject({
      includedParts: 1_000,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: null,
      overageCentsPerPart: 11
    });
  });

  it('creates an owner-only backup without authentication or provider secrets', async () => {
    const owner = await seedOwner();
    const organisationId = randomUUID();
    const customerUserId = randomUUID();
    const customerCognitoSubject = `must-not-be-exported-${randomUUID()}`;
    const customerEmail = `backup-customer-${customerUserId}@example.invalid`;
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Backup Test Customer',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(users).values({
      id: customerUserId,
      cognitoSubject: customerCognitoSubject,
      email: customerEmail,
      displayName: 'Backup Customer'
    });
    await client.db.insert(memberships).values({
      organisationId,
      userId: customerUserId,
      role: 'ADMIN'
    });
    const service = createPlatformCustomerBackupService({
      verifyOwner: (userId) => Promise.resolve(userId === owner.userId),
      database: client.db,
      clock: { now: () => new Date('2026-11-11T02:00:00.000Z') }
    });

    const backup = await service.createBackup(owner.userId, organisationId);
    const encoded = JSON.stringify(backup);

    expect(encoded).toContain('Backup Test Customer');
    expect(encoded).toContain(customerEmail);
    expect(encoded).not.toContain(customerCognitoSubject);
    await expect(
      service.createBackup(customerUserId, organisationId)
    ).rejects.toThrow('FORBIDDEN');
  });
});
