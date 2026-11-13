import { randomInt, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  migrateDatabase,
  organisations,
  PostgresReplyNumberProvisioningRepository,
  replyNumberProvisioningRequests,
  smsNumberPool,
  subscriptions
} from '@bc5000/db';

import { provisionPaidSmsNumber } from '../src/handlers/sms-number-provision.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const repository = new PostgresReplyNumberProvisioningRepository(client.db);
const now = new Date('2026-11-12T02:30:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('SMS number provisioning worker manual control plane', () => {
  it('creates one request concurrently without claiming or promoting a pool number', async () => {
    const organisationId = randomUUID();
    const stripeSubscriptionId = `sub_${organisationId}`;
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `worker-reply-${organisationId}`,
      name: 'Worker reply number organisation',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO',
      platformStatus: 'ACTIVE'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'ACTIVE',
      trustedStripeProviderStatus: 'active',
      currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
      stripeSubscriptionId,
      initialCardStripeSubscriptionId: stripeSubscriptionId,
      initialCardInvoiceId: `in_${organisationId}`,
      initialCardPaymentSucceededAt: new Date('2026-11-01T00:01:00.000Z')
    });
    const [available] = await client.db
      .insert(smsNumberPool)
      .values({
        e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
        provider: 'SINCH',
        providerNumberId: `sinch-${randomUUID()}`,
        providerVerifiedAt: now,
        status: 'AVAILABLE'
      })
      .returning({ id: smsNumberPool.id });
    if (!available) throw new Error('available number insert failed');

    await expect(
      Promise.all(
        Array.from({ length: 5 }, () =>
          provisionPaidSmsNumber(
            { repository, clock: { now: () => now } },
            { organisationId }
          )
        )
      )
    ).resolves.toEqual(Array.from({ length: 5 }, () => 'OWNER_ACTION_REQUIRED'));

    await expect(
      client.db
        .select()
        .from(replyNumberProvisioningRequests)
        .where(eq(replyNumberProvisioningRequests.organisationId, organisationId))
    ).resolves.toHaveLength(1);
    await expect(
      client.db
        .select({
          status: smsNumberPool.status,
          organisationId: smsNumberPool.organisationId,
          readyAt: smsNumberPool.readyAt
        })
        .from(smsNumberPool)
        .where(eq(smsNumberPool.id, available.id))
    ).resolves.toEqual([
      { status: 'AVAILABLE', organisationId: null, readyAt: null }
    ]);
  });

  it('completes a stale job without creating a request for an unpaid organisation', async () => {
    const organisationId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `worker-reply-unpaid-${organisationId}`,
      name: 'Unpaid worker reply number organisation',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO',
      platformStatus: 'ACTIVE'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'CANCELLED',
      trustedStripeProviderStatus: 'canceled',
      cancelledAt: now
    });

    await expect(
      provisionPaidSmsNumber(
        { repository, clock: { now: () => now } },
        { organisationId }
      )
    ).resolves.toBe('OWNER_ACTION_REQUIRED');
    await expect(
      client.db
        .select()
        .from(replyNumberProvisioningRequests)
        .where(eq(replyNumberProvisioningRequests.organisationId, organisationId))
    ).resolves.toHaveLength(0);
  });
});
