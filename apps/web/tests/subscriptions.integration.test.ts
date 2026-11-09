import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  memberships,
  organisations,
  subscriptionEvents,
  subscriptions,
  users
} from '@bc5000/db';
import type { StripeWebhookEvent } from '@bc5000/integrations/stripe';

import { createPostgresSubscriptionRepository } from '../src/server/subscription-repository.js';
import {
  createSubscriptionService,
  type StripeBillingGateway
} from '../src/server/subscription-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-09T12:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

class FakeStripe implements StripeBillingGateway {
  event: StripeWebhookEvent | undefined;

  createSoloCheckout() {
    return Promise.resolve({ id: 'cs_test', url: 'https://checkout.stripe.test' });
  }

  createBillingPortal() {
    return Promise.resolve({ id: 'bps_test', url: 'https://billing.stripe.test' });
  }

  verifyWebhook(): StripeWebhookEvent {
    if (this.event === undefined) throw new Error('No event configured');
    return this.event;
  }
}

const stripeEvent = (input: {
  id: string;
  created: number;
  status: string;
  cancelAtPeriodEnd?: boolean;
  priceId?: string;
  currency?: string;
}): StripeWebhookEvent => {
  const currency = input.currency ?? 'aud';
  return {
    id: input.id,
    type: 'customer.subscription.updated',
    created: input.created,
    data: {
      object: {
        id: 'sub_integration',
        customer: 'cus_integration',
        status: input.status,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        current_period_start: 1_794_201_600,
        current_period_end: 1_796_880_000,
        trial_end: null,
        cancel_at: input.cancelAtPeriodEnd ? 1_796_880_000 : null,
        canceled_at: input.status === 'canceled' ? input.created : null,
        currency,
        metadata: {
          organisation_id: currentOrganisationId,
          plan_code: 'SOLO_AU_2000'
        },
        items: {
          data: [
            {
              price: {
                id: input.priceId ?? 'price_solo_au_2000',
                currency,
                recurring: { interval: 'month' }
              }
            }
          ]
        }
      }
    }
  };
};

let currentOrganisationId = '';

const seed = async () => {
  const organisationId = randomUUID();
  const userId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Solo subscription test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Billing Admin'
  });
  await client.db.insert(memberships).values({
    organisationId,
    userId,
    role: 'ADMIN'
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: 'TRIALING',
    trialEndsAt: new Date('2026-11-23T12:00:00.000Z')
  });
  const session: AppSession = {
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'Billing Admin',
    expiresAt: '2026-11-10T00:00:00.000Z',
    memberships: [{ organisationId, role: 'ADMIN', active: true }]
  };
  return { organisationId, session };
};

describe('AccountPulse Solo subscription persistence', () => {
  it('deduplicates and orders webhooks while pausing sends on billing risk', async () => {
    const seeded = await seed();
    currentOrganisationId = seeded.organisationId;
    const stripe = new FakeStripe();
    const lifecycleJobs: string[] = [];
    const service = createSubscriptionService({
      stripe,
      repository: createPostgresSubscriptionRepository(client.db, {
        now: () => now
      }),
      soloPriceId: 'price_solo_au_2000',
      clock: { now: () => now },
      publishLifecycle: (job) => {
        lifecycleJobs.push(job.organisationId);
        return Promise.resolve();
      },
      publishNumberProvision: () => Promise.resolve()
    });

    stripe.event = stripeEvent({
      id: `evt_${randomUUID()}`,
      created: 1_794_201_600,
      status: 'active'
    });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe('APPLIED');
    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe('DUPLICATE');

    stripe.event = stripeEvent({
      id: `evt_${randomUUID()}`,
      created: 1_794_197_999,
      status: 'past_due'
    });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe(
      'IGNORED_OUT_OF_ORDER'
    );

    stripe.event = stripeEvent({
      id: `evt_${randomUUID()}`,
      created: 1_794_205_200,
      status: 'past_due'
    });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe('APPLIED');

    const [subscription] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, seeded.organisationId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(subscription?.status).toBe('PAST_DUE');
    expect(organisation).toMatchObject({
      sendMode: 'dry-run',
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: false
    });
    expect(lifecycleJobs).toEqual([]);
  });

  it('rejects the wrong price without changing entitlement or leaking IDs to audit', async () => {
    const seeded = await seed();
    currentOrganisationId = seeded.organisationId;
    const stripe = new FakeStripe();
    const service = createSubscriptionService({
      stripe,
      repository: createPostgresSubscriptionRepository(client.db, {
        now: () => now
      }),
      soloPriceId: 'price_solo_au_2000',
      clock: { now: () => now },
      publishLifecycle: () => Promise.resolve(),
      publishNumberProvision: () => Promise.resolve()
    });
    const eventId = `evt_${randomUUID()}`;
    stripe.event = stripeEvent({
      id: eventId,
      created: 1_794_201_600,
      status: 'active',
      priceId: 'price_unapproved'
    });

    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe('REJECTED');
    const [subscription] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, seeded.organisationId));
    const [event] = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId));
    const auditRows = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(subscription?.status).toBe('TRIALING');
    expect(event?.outcome).toBe('REJECTED');
    expect(JSON.stringify(auditRows)).not.toContain('cus_integration');
    expect(JSON.stringify(auditRows)).not.toContain('sub_integration');
  });
});
