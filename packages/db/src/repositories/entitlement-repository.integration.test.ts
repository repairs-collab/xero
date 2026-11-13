import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  organisationOnboarding,
  organisations,
  outboundMessages,
  subscriptions
} from '../schema/index.js';
import { PostgresEntitlementRepository } from './entitlement-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const repository = new PostgresEntitlementRepository(client.db);
const now = new Date('2026-11-10T00:00:00.000Z');

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

const seedOrganisation = async (input: {
  edition: 'INTERNAL_LEGACY' | 'SOLO';
  subscriptionStatus?: 'TRIALING' | 'ACTIVE';
  trialEndsAt?: Date | null;
  completed?: boolean;
  numberReady?: boolean;
  platformStatus?: 'ACTIVE' | 'SUSPENDED';
}) => {
  const organisationId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: `Entitlement ${organisationId}`,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: input.edition,
    platformStatus: input.platformStatus ?? 'ACTIVE',
    suspendedAt: input.platformStatus === 'SUSPENDED' ? now : null,
    suspensionReason:
      input.platformStatus === 'SUSPENDED' ? 'Owner review' : null
  });
  if (input.edition === 'SOLO') {
    const subscriptionStatus = input.subscriptionStatus ?? 'TRIALING';
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: subscriptionStatus,
      trialEndsAt: input.trialEndsAt ?? new Date('2026-11-24T00:00:00.000Z'),
      ...(subscriptionStatus === 'ACTIVE'
        ? {
            trustedStripeProviderStatus: 'active',
            currentPeriodStart: new Date('2026-11-09T00:00:00.000Z'),
            currentPeriodEnd: new Date('2026-12-09T00:00:00.000Z')
          }
        : {})
    });
    await client.db.insert(organisationOnboarding).values({
      organisationId,
      version: 1,
      completedVersion: input.completed ? 1 : null,
      completedAt: input.completed ? now : null,
      adminMobile: '+61412345678',
      adminMobileVerifiedAt: now,
      replyNumberReadyAt: input.numberReady ? now : null
    });
  }
  return organisationId;
};

describe('PostgresEntitlementRepository', () => {
  it('enforces cancellation provenance and the period boundary', async () => {
    const organisationId = await seedOrganisation({ edition: 'SOLO', subscriptionStatus: 'ACTIVE', completed: true, numberReady: true });
    await client.db.update(subscriptions).set({ status: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodStart: new Date(now.getTime() - 1000), currentPeriodEnd: now }).where(eq(subscriptions.organisationId, organisationId));
    await expect(repository.decide(organisationId, new Date(now.getTime() - 1))).resolves.toMatchObject({ canCustomerSend: true });
    await expect(repository.decide(organisationId, now)).resolves.toMatchObject({ canCustomerSend: false });
    await client.db.update(subscriptions).set({ status: 'CANCEL_AT_PERIOD_END', trustedStripeProviderStatus: null, currentPeriodEnd: new Date(now.getTime() + 1000) }).where(eq(subscriptions.organisationId, organisationId));
    await expect(repository.decide(organisationId, now)).resolves.toMatchObject({ canCustomerSend: false });
  });

  it('blocks all sending capabilities for a suspended account', async () => {
    const organisationId = await seedOrganisation({
      edition: 'INTERNAL_LEGACY',
      platformStatus: 'SUSPENDED'
    });

    await expect(repository.decide(organisationId, now)).resolves.toMatchObject({
      canRead: true,
      canPreview: false,
      canVerifiedAdminTest: false,
      canCustomerSend: false,
      canAutomaticDispatch: false,
      blocker: 'ACCOUNT_SUSPENDED'
    });
  });

  it('preserves legacy behaviour and gates paid Solo on evidence', async () => {
    const legacyId = await seedOrganisation({ edition: 'INTERNAL_LEGACY' });
    const incompleteSoloId = await seedOrganisation({
      edition: 'SOLO',
      subscriptionStatus: 'ACTIVE'
    });
    const readySoloId = await seedOrganisation({
      edition: 'SOLO',
      subscriptionStatus: 'ACTIVE',
      completed: true,
      numberReady: true
    });

    await expect(repository.decide(legacyId, now)).resolves.toMatchObject({
      canCustomerSend: true,
      canAutomaticDispatch: true
    });
    await expect(
      repository.decide(incompleteSoloId, now)
    ).resolves.toMatchObject({
      canCustomerSend: false,
      blocker: 'ONBOARDING_INCOMPLETE'
    });
    await expect(repository.decide(readySoloId, now)).resolves.toMatchObject({
      canCustomerSend: true,
      canAutomaticDispatch: true,
      blocker: null
    });
  });

  it('counts rendered trial SMS parts only inside the requested tenant', async () => {
    const organisationId = await seedOrganisation({ edition: 'SOLO' });
    const otherId = await seedOrganisation({ edition: 'SOLO' });
    await client.db.insert(outboundMessages).values([
      {
        organisationId,
        channel: 'SMS',
        source: 'TEST_SMS',
        recipientKey: '+61412345678',
        content: 'A'.repeat(161),
        contentHash: 'hash-one',
        status: 'ACCEPTED',
        idempotencyKey: randomUUID()
      },
      {
        organisationId: otherId,
        channel: 'SMS',
        source: 'TEST_SMS',
        recipientKey: '+61412345678',
        content: 'A'.repeat(161),
        contentHash: 'hash-two',
        status: 'ACCEPTED',
        idempotencyKey: randomUUID()
      }
    ]);

    await expect(repository.decide(organisationId, now)).resolves.toMatchObject({
      remainingTrialTestSmsParts: 8,
      canVerifiedAdminTest: true
    });
  });
});
