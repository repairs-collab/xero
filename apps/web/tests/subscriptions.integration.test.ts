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

  loadChargeOwnership() {
    return Promise.reject(new Error('Charge ownership is not used by lifecycle tests'));
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
        id: 'sub_' + currentOrganisationId,
        customer: 'cus_' + currentOrganisationId,
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
    memberships: [{ organisationId, role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }]
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

  it.each([
    ['active', 'CANCEL_AT_PERIOD_END', 'live', 'CUSTOMER', true, 1],
    ['past_due', 'PAST_DUE', 'dry-run', 'CONTROLLED', false, 0],
    ['unpaid', 'PAST_DUE', 'dry-run', 'CONTROLLED', false, 0]
  ] as const)('handles scheduled cancellation for %s safely', async (status, expectedStatus, sendMode, rolloutScope, acknowledged, provisionCount) => {
    const seeded = await seed();
    currentOrganisationId = seeded.organisationId;
    const stripe = new FakeStripe();
    const provisionJobs: string[] = [];
    const service = createSubscriptionService({
      stripe,
      repository: createPostgresSubscriptionRepository(client.db, { now: () => now }),
      soloPriceId: 'price_solo_au_2000',
      clock: { now: () => now },
      publishLifecycle: () => Promise.resolve(),
      publishNumberProvision: (job) => { provisionJobs.push(job.organisationId); return Promise.resolve(); }
    });
    stripe.event = stripeEvent({ id: 'evt_' + randomUUID(), created: 1_794_201_600, status, cancelAtPeriodEnd: true });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toBe('APPLIED');
    const [subscription] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, seeded.organisationId));
    const [organisation] = await client.db.select().from(organisations).where(eq(organisations.id, seeded.organisationId));
    expect(subscription?.status).toBe(expectedStatus);
    expect(organisation).toMatchObject({ sendMode, rolloutScope, liveSendAcknowledged: acknowledged });
    expect(provisionJobs).toHaveLength(provisionCount);
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
    expect(JSON.stringify(auditRows)).not.toContain('cus_' + seeded.organisationId);
    expect(JSON.stringify(auditRows)).not.toContain('sub_' + seeded.organisationId);
  });
});


describe('resubscription and immutable trial persistence', () => {
  it.each(['checkout-first', 'lifecycle-first'])('handles %s and rejects old and mismatched IDs', async (order) => {
    const { organisationId } = await seed();
    const repository = createPostgresSubscriptionRepository(client.db, {now: () => now});
    const customer = 'cus_' + organisationId;
    const old = 'sub_old_' + organisationId;
    const replacement = 'sub_new_' + organisationId;
    const initialTrial = new Date('2026-11-23T12:00:00Z');
    await client.db.update(subscriptions).set({status:'CANCELLED', stripeProviderStatus:'canceled', stripeCustomerId:customer, stripeSubscriptionId:old, lastStripeEventCreatedAt:new Date('2026-11-09T10:00:00Z')}).where(eq(subscriptions.organisationId, organisationId));
    const common = {organisationId, eventCreatedAt:new Date('2026-11-09T11:00:00Z'), payloadHash:'a'.repeat(64), stripeCustomerId:customer, stripeSubscriptionId:replacement};
    const checkout = {...common, eventId:'evt_checkout_' + organisationId, eventType:'checkout.session.completed' as const};
    const lifecycle = {...common, eventId:'evt_lifecycle_' + organisationId, eventType:'customer.subscription.created', planCode:'SOLO_AU_2000' as const, status:'ACTIVE' as const, stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:new Date('2026-12-01T00:00:00Z'), cancelAt:null, cancelledAt:null};
    if (order === 'checkout-first') {
      expect(await repository.applyCheckoutCompleted(checkout)).toBe('APPLIED');
      const [before] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
      expect(before?.status).toBe('CANCELLED');
      expect(await repository.applyLifecycleEvent(lifecycle)).toBe('APPLIED');
    } else {
      expect(await repository.applyLifecycleEvent(lifecycle)).toBe('APPLIED');
      expect(await repository.applyCheckoutCompleted(checkout)).toBe('APPLIED');
    }
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_stale_' + organisationId, stripeSubscriptionId:old, eventCreatedAt:new Date('2026-11-09T12:00:00Z')})).toBe('REJECTED');
    expect(await repository.applyCheckoutCompleted({...checkout, eventId:'evt_foreign_' + organisationId, stripeCustomerId:'cus_foreign', stripeSubscriptionId:'sub_foreign'})).toBe('REJECTED');
    const [row] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(row?.stripeSubscriptionId).toBe(replacement);
    expect(row?.trialEndsAt).toEqual(initialTrial);
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_equal_risk_' + organisationId, status:'PAST_DUE', stripeProviderStatus:'past_due', trialEndsAt:null})).toBe('APPLIED');
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_equal_active_' + organisationId})).toBe('IGNORED_OUT_OF_ORDER');
    const shorter = new Date('2026-11-20T12:00:00Z');
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_short_' + organisationId, eventCreatedAt:new Date('2026-11-09T13:00:00Z'), trialEndsAt:shorter})).toBe('APPLIED');
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_null_' + organisationId, eventCreatedAt:new Date('2026-11-09T14:00:00Z'), trialEndsAt:null})).toBe('APPLIED');
    const [shortened] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(shortened?.trialEndsAt).toEqual(shorter);
  });

  it('rejects Stripe IDs that are already owned by another tenant', async () => {
    const target = await seed();
    const foreign = await seed();
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    const foreignCustomerId = `cus_${foreign.organisationId}`;
    const foreignSubscriptionId = `sub_${foreign.organisationId}`;
    await client.db
      .update(subscriptions)
      .set({
        status: 'ACTIVE',
        stripeProviderStatus: 'active',
        stripeCustomerId: foreignCustomerId,
        stripeSubscriptionId: foreignSubscriptionId,
        currentPeriodStart: new Date('2026-11-09T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-12-09T00:00:00.000Z'),
        lastStripeEventCreatedAt: new Date('2026-11-09T10:00:00.000Z')
      })
      .where(eq(subscriptions.organisationId, foreign.organisationId));

    const checkoutEventId = `evt_cross_tenant_checkout_${target.organisationId}`;
    await expect(
      repository.applyCheckoutCompleted({
        organisationId: target.organisationId,
        eventId: checkoutEventId,
        eventType: 'checkout.session.completed',
        eventCreatedAt: new Date('2026-11-09T11:00:00.000Z'),
        payloadHash: 'c'.repeat(64),
        stripeCustomerId: foreignCustomerId,
        stripeSubscriptionId: foreignSubscriptionId
      })
    ).resolves.toBe('REJECTED');

    const lifecycleEventId = `evt_cross_tenant_lifecycle_${target.organisationId}`;
    await expect(
      repository.applyLifecycleEvent({
        organisationId: target.organisationId,
        eventId: lifecycleEventId,
        eventType: 'customer.subscription.created',
        eventCreatedAt: new Date('2026-11-09T12:00:00.000Z'),
        payloadHash: 'd'.repeat(64),
        stripeCustomerId: foreignCustomerId,
        stripeSubscriptionId: foreignSubscriptionId,
        planCode: 'SOLO_AU_2000',
        status: 'ACTIVE',
        stripeProviderStatus: 'active',
        currentPeriodStart: new Date('2026-11-09T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-12-09T00:00:00.000Z'),
        trialEndsAt: null,
        cancelAt: null,
        cancelledAt: null
      })
    ).resolves.toBe('REJECTED');

    const [targetRow] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, target.organisationId));
    const [foreignRow] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, foreign.organisationId));
    const [checkoutEvent] = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, checkoutEventId));
    const [lifecycleEvent] = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, lifecycleEventId));

    expect(targetRow?.status).toBe('TRIALING');
    expect(targetRow?.stripeCustomerId).toBeNull();
    expect(targetRow?.stripeSubscriptionId).toBeNull();
    expect(foreignRow?.stripeCustomerId).toBe(foreignCustomerId);
    expect(foreignRow?.stripeSubscriptionId).toBe(foreignSubscriptionId);
    expect(checkoutEvent?.outcome).toBe('REJECTED');
    expect(lifecycleEvent?.outcome).toBe('REJECTED');
  });
});


describe('competing checkout replacement order', () => {
  it.each(['older', 'equal'])('ignores a %s second checkout and preserves same-second lifecycle', async (ordering) => {
    const {organisationId} = await seed();
    const repository = createPostgresSubscriptionRepository(client.db, {now: () => now});
    const customer = 'cus_' + organisationId;
    const initialId = 'sub_old_' + organisationId;
    const newerId = 'sub_b_' + organisationId;
    await client.db.update(subscriptions).set({status:'CANCELLED', stripeProviderStatus:'canceled', stripeCustomerId:customer, stripeSubscriptionId:initialId, lastStripeEventCreatedAt:new Date('2026-11-09T10:00:00Z')}).where(eq(subscriptions.organisationId, organisationId));
    const common = {organisationId, payloadHash:'a'.repeat(64), stripeCustomerId:customer, eventType:'checkout.session.completed' as const};
    const newerTime = new Date('2026-11-09T11:00:00Z');
    expect(await repository.applyCheckoutCompleted({...common, eventId:'evt_b_' + organisationId, eventCreatedAt:newerTime, stripeSubscriptionId:newerId})).toBe('APPLIED');
    const [afterCheckout] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(afterCheckout?.status).toBe('CANCELLED');
    const ignoredId = 'sub_a_' + organisationId;
    expect(await repository.applyCheckoutCompleted({...common, eventId:'evt_a_' + organisationId, eventCreatedAt:ordering === 'older' ? new Date('2026-11-09T10:30:00Z') : newerTime, stripeSubscriptionId:ignoredId})).toBe('IGNORED_OUT_OF_ORDER');
    const [beforeLifecycle] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(beforeLifecycle?.stripeSubscriptionId).toBe(newerId);
    expect(await repository.applyLifecycleEvent({organisationId, eventId:'evt_stale_candidate_' + organisationId, eventType:'customer.subscription.created', eventCreatedAt:new Date('2026-11-09T12:00:00Z'), payloadHash:'b'.repeat(64), stripeCustomerId:customer, stripeSubscriptionId:ignoredId, planCode:'SOLO_AU_2000', status:'ACTIVE', stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:null, cancelAt:null, cancelledAt:null})).toBe('REJECTED');
    const [afterStaleLifecycle] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(afterStaleLifecycle?.stripeSubscriptionId).toBe(newerId);
    expect(await repository.applyLifecycleEvent({organisationId, eventId:'evt_live_' + organisationId, eventType:'customer.subscription.created', eventCreatedAt:newerTime, payloadHash:'a'.repeat(64), stripeCustomerId:customer, stripeSubscriptionId:newerId, planCode:'SOLO_AU_2000', status:'ACTIVE', stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:null, cancelAt:null, cancelledAt:null})).toBe('APPLIED');
  });

  it('rejects an older competing lifecycle that arrives before its Checkout', async () => {
    const {organisationId} = await seed();
    const repository = createPostgresSubscriptionRepository(client.db, {now: () => now});
    const customer = 'cus_' + organisationId;
    const initialId = 'sub_old_' + organisationId;
    const selectedId = 'sub_b_' + organisationId;
    const staleId = 'sub_a_' + organisationId;
    const selectedTime = new Date('2026-11-09T11:00:00Z');
    const staleTime = new Date('2026-11-09T10:30:00Z');
    await client.db.update(subscriptions).set({status:'CANCELLED', stripeProviderStatus:'canceled', stripeCustomerId:customer, stripeSubscriptionId:initialId, lastStripeEventCreatedAt:new Date('2026-11-09T10:00:00Z')}).where(eq(subscriptions.organisationId, organisationId));
    const checkout = {organisationId, eventType:'checkout.session.completed' as const, payloadHash:'c'.repeat(64), stripeCustomerId:customer};
    expect(await repository.applyCheckoutCompleted({...checkout, eventId:'evt_selected_checkout_' + organisationId, eventCreatedAt:selectedTime, stripeSubscriptionId:selectedId})).toBe('APPLIED');
    const lifecycle = {organisationId, eventType:'customer.subscription.created', payloadHash:'d'.repeat(64), stripeCustomerId:customer, planCode:'SOLO_AU_2000' as const, status:'ACTIVE' as const, stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:null, cancelAt:null, cancelledAt:null};
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_stale_lifecycle_first_' + organisationId, eventCreatedAt:staleTime, stripeSubscriptionId:staleId})).toBe('IGNORED_OUT_OF_ORDER');
    expect(await repository.applyCheckoutCompleted({...checkout, eventId:'evt_stale_checkout_later_' + organisationId, eventCreatedAt:staleTime, stripeSubscriptionId:staleId})).toBe('REJECTED');
    const [afterStaleCandidate] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(afterStaleCandidate?.stripeSubscriptionId).toBe(selectedId);
    expect(afterStaleCandidate?.status).toBe('CANCELLED');
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_selected_lifecycle_' + organisationId, eventCreatedAt:selectedTime, stripeSubscriptionId:selectedId})).toBe('APPLIED');
  });
});
