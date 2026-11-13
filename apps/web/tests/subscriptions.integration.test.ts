import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import {
  type SoloCheckoutRequest,
  type StripeCheckoutSession,
  type StripeWebhookEvent
} from '@bc5000/integrations/stripe';

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

  checkoutRequests: SoloCheckoutRequest[] = [];
  checkoutSessions = new Map<string, StripeCheckoutSession>();
  loseResponse = false;
  loseBeforeCreate = false;
  rejectBeforeCreate = false;

  checkoutConfiguration(cadence: 'MONTHLY' | 'ANNUAL') {
    return {
      priceId: cadence === 'MONTHLY' ? 'price_solo_au_2000' : 'price_solo_annual',
      automaticTaxEnabled: true,
      publicOrigin: 'https://ap.test'
    };
  }

  createSoloCheckout(request: SoloCheckoutRequest) {
    this.checkoutRequests.push(request);
    if (this.loseBeforeCreate) {
      this.loseBeforeCreate = false;
      return Promise.reject(new Error('lost response before execution'));
    }
    if (this.rejectBeforeCreate) {
      this.rejectBeforeCreate = false;
      return Promise.reject(
        Object.assign(new Error('Stripe rejected the Checkout request'), {
          code: 'STRIPE_CHECKOUT_REQUEST_REJECTED',
          providerRequestId: 'req_expired_checkout'
        })
      );
    }
    let session = this.checkoutSessions.get(request.idempotencyKey);
    if (session === undefined) {
      session = {
        id: 'cs_' + randomUUID(),
        url: 'https://checkout.stripe.test/' + randomUUID(),
        organisationId: request.organisationId,
        attemptId: request.attemptId,
        billingCadence: request.billingCadence,
        expiresAt: request.expiresAt,
        status: 'open',
        stripeCustomerId: request.stripeCustomerId ?? null,
        stripeSubscriptionId: null
      };
      this.checkoutSessions.set(request.idempotencyKey, session);
    }
    if (this.loseResponse) {
      this.loseResponse = false;
      return Promise.reject(new Error('lost response'));
    }
    return Promise.resolve({ ...session });
  }

  retrieveSoloCheckout(id: string) {
    const session = [...this.checkoutSessions.values()].find((row) => row.id === id);
    if (session === undefined) return Promise.reject(new Error('missing Session'));
    return Promise.resolve({ ...session });
  }

  createBillingPortal() {
    return Promise.resolve({ id: 'bps_test', url: 'https://billing.stripe.test' });
  }

  createDirectDebitSetup() {
    return Promise.resolve({
      id: 'cs_becs_test',
      url: 'https://checkout.stripe.test/becs',
      expiresAt: new Date('2026-11-10T12:00:00.000Z')
    });
  }

  activateDirectDebit() {
    return Promise.resolve();
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
        object: 'subscription',
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
      soloMonthlyPriceId: 'price_solo_au_2000',
      soloAnnualPriceId: 'price_solo_annual',
      verifyPlatformOwner: () => Promise.resolve(false),
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
      soloMonthlyPriceId: 'price_solo_au_2000',
      soloAnnualPriceId: 'price_solo_annual',
      verifyPlatformOwner: () => Promise.resolve(false),
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
      soloMonthlyPriceId: 'price_solo_au_2000',
      soloAnnualPriceId: 'price_solo_annual',
      verifyPlatformOwner: () => Promise.resolve(false),
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

  it('rejects reused lifecycle and Checkout event IDs with different payload hashes', async () => {
    const { organisationId } = await seed();
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    const stripeCustomerId = `cus_${organisationId}`;
    const stripeSubscriptionId = `sub_${organisationId}`;
    const lifecycle = {
      organisationId,
      eventId: `evt_lifecycle_hash_${organisationId}`,
      eventType: 'customer.subscription.created',
      eventCreatedAt: new Date('2026-11-09T11:00:00.000Z'),
      payloadHash: 'a'.repeat(64),
      stripeCustomerId,
      stripeSubscriptionId,
      planCode: 'SOLO_AU_2000' as const,
      billingCadence: 'MONTHLY' as const,
      status: 'ACTIVE' as const,
      stripeProviderStatus: 'active',
      currentPeriodStart: new Date('2026-11-09T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-12-09T00:00:00.000Z'),
      trialEndsAt: null,
      cancelAt: null,
      cancelledAt: null
    };

    await expect(repository.applyLifecycleEvent(lifecycle)).resolves.toBe(
      'APPLIED'
    );
    await expect(
      repository.applyLifecycleEvent({
        ...lifecycle,
        payloadHash: 'b'.repeat(64)
      })
    ).rejects.toThrow('STRIPE_EVENT_PAYLOAD_MISMATCH');

    const checkout = {
      organisationId,
      eventId: `evt_checkout_hash_${organisationId}`,
      eventType: 'checkout.session.completed' as const,
      eventCreatedAt: new Date('2026-11-09T11:00:01.000Z'),
      payloadHash: 'c'.repeat(64),
      stripeCustomerId,
      stripeSubscriptionId,
      initialCardInvoiceId: `in_${organisationId}`,
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:00:01.000Z')
    };
    await expect(repository.applyCheckoutCompleted(checkout)).resolves.toBe(
      'APPLIED'
    );
    await expect(
      repository.applyCheckoutCompleted({
        ...checkout,
        payloadHash: 'd'.repeat(64)
      })
    ).rejects.toThrow('STRIPE_EVENT_PAYLOAD_MISMATCH');
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
    const checkout = {...common, eventId:'evt_checkout_' + organisationId, eventType:'checkout.session.completed' as const, initialCardInvoiceId:'in_' + organisationId, initialCardPaymentSucceededAt:new Date('2026-11-09T11:00:00Z')};
    const lifecycle = {...common, eventId:'evt_lifecycle_' + organisationId, eventType:'customer.subscription.created', planCode:'SOLO_AU_2000' as const, billingCadence:'MONTHLY' as const, status:'ACTIVE' as const, stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:new Date('2026-12-01T00:00:00Z'), cancelAt:null, cancelledAt:null};
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
        stripeSubscriptionId: foreignSubscriptionId,
        initialCardInvoiceId: `in_${target.organisationId}`,
        initialCardPaymentSucceededAt: new Date(
          '2026-11-09T11:00:00.000Z'
        )
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
        billingCadence: 'MONTHLY',
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
    const common = {organisationId, payloadHash:'a'.repeat(64), stripeCustomerId:customer, eventType:'checkout.session.completed' as const, initialCardInvoiceId:'in_' + organisationId, initialCardPaymentSucceededAt:new Date('2026-11-09T11:00:00Z')};
    const newerTime = new Date('2026-11-09T11:00:00Z');
    expect(await repository.applyCheckoutCompleted({...common, eventId:'evt_b_' + organisationId, eventCreatedAt:newerTime, stripeSubscriptionId:newerId})).toBe('APPLIED');
    const [afterCheckout] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(afterCheckout?.status).toBe('CANCELLED');
    const ignoredId = 'sub_a_' + organisationId;
    expect(await repository.applyCheckoutCompleted({...common, eventId:'evt_a_' + organisationId, eventCreatedAt:ordering === 'older' ? new Date('2026-11-09T10:30:00Z') : newerTime, stripeSubscriptionId:ignoredId})).toBe('IGNORED_OUT_OF_ORDER');
    const [beforeLifecycle] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(beforeLifecycle?.stripeSubscriptionId).toBe(newerId);
    expect(await repository.applyLifecycleEvent({organisationId, eventId:'evt_stale_candidate_' + organisationId, eventType:'customer.subscription.created', eventCreatedAt:new Date('2026-11-09T12:00:00Z'), payloadHash:'b'.repeat(64), stripeCustomerId:customer, stripeSubscriptionId:ignoredId, planCode:'SOLO_AU_2000', billingCadence:'MONTHLY', status:'ACTIVE', stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:null, cancelAt:null, cancelledAt:null})).toBe('REJECTED');
    const [afterStaleLifecycle] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(afterStaleLifecycle?.stripeSubscriptionId).toBe(newerId);
    expect(await repository.applyLifecycleEvent({organisationId, eventId:'evt_live_' + organisationId, eventType:'customer.subscription.created', eventCreatedAt:newerTime, payloadHash:'a'.repeat(64), stripeCustomerId:customer, stripeSubscriptionId:newerId, planCode:'SOLO_AU_2000', billingCadence:'MONTHLY', status:'ACTIVE', stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:null, cancelAt:null, cancelledAt:null})).toBe('APPLIED');
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
    const checkout = {organisationId, eventType:'checkout.session.completed' as const, payloadHash:'c'.repeat(64), stripeCustomerId:customer, initialCardInvoiceId:'in_' + organisationId, initialCardPaymentSucceededAt:new Date('2026-11-09T11:00:00Z')};
    expect(await repository.applyCheckoutCompleted({...checkout, eventId:'evt_selected_checkout_' + organisationId, eventCreatedAt:selectedTime, stripeSubscriptionId:selectedId})).toBe('APPLIED');
    const lifecycle = {organisationId, eventType:'customer.subscription.created', payloadHash:'d'.repeat(64), stripeCustomerId:customer, planCode:'SOLO_AU_2000' as const, billingCadence:'MONTHLY' as const, status:'ACTIVE' as const, stripeProviderStatus:'active', currentPeriodStart:new Date('2026-11-09T00:00:00Z'), currentPeriodEnd:new Date('2026-12-09T00:00:00Z'), trialEndsAt:null, cancelAt:null, cancelledAt:null};
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_stale_lifecycle_first_' + organisationId, eventCreatedAt:staleTime, stripeSubscriptionId:staleId})).toBe('IGNORED_OUT_OF_ORDER');
    expect(await repository.applyCheckoutCompleted({...checkout, eventId:'evt_stale_checkout_later_' + organisationId, eventCreatedAt:staleTime, stripeSubscriptionId:staleId})).toBe('REJECTED');
    const [afterStaleCandidate] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(afterStaleCandidate?.stripeSubscriptionId).toBe(selectedId);
    expect(afterStaleCandidate?.status).toBe('CANCELLED');
    expect(await repository.applyLifecycleEvent({...lifecycle, eventId:'evt_selected_lifecycle_' + organisationId, eventCreatedAt:selectedTime, stripeSubscriptionId:selectedId})).toBe('APPLIED');
  });
});

describe('single paid Checkout across cadences', () => {
  const checkoutFixture = async () => {
    const seeded = await seed();
    const stripe = new FakeStripe();
    let currentTime = now;
    const clock = { now: () => currentTime };
    const repository = createPostgresSubscriptionRepository(client.db, clock);
    const services = [repository, createPostgresSubscriptionRepository(client.db, clock)].map(
      (repo) => createSubscriptionService({
        stripe,
        repository: repo,
        soloMonthlyPriceId: 'price_solo_au_2000',
        soloAnnualPriceId: 'price_solo_annual',
        verifyPlatformOwner: () => Promise.resolve(false),
        clock,
        publishLifecycle: () => Promise.resolve(),
        publishNumberProvision: () => Promise.resolve()
      })
    );
    return {
      ...seeded,
      stripe,
      repository,
      checkout: (cadence: 'MONTHLY' | 'ANNUAL' = 'MONTHLY', instance = 0) =>
        services[instance]!.createCheckout(seeded.session, seeded.organisationId, cadence),
      webhook: (event: StripeWebhookEvent) => {
        stripe.event = event;
        return services[1]!.handleWebhook(JSON.stringify(event), 'signed');
      },
      advance: (seconds: number) => { currentTime = new Date(currentTime.getTime() + seconds * 1000); }
    };
  };

  it('allows only one payable Session in a monthly versus annual race', async () => {
    const { checkout, stripe } = await checkoutFixture();
    const outcomes = await Promise.allSettled([checkout(), checkout('ANNUAL', 1)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    expect(stripe.checkoutSessions.size).toBe(1);
  });

  it('converges simultaneous same-cadence calls on one provider Session', async () => {
    const { checkout, stripe } = await checkoutFixture();
    const hosted = await Promise.all([checkout(), checkout('MONTHLY', 1)]);
    expect(hosted[1]).toEqual(hosted[0]);
    expect(stripe.checkoutSessions.size).toBe(1);
    expect(stripe.checkoutRequests[0]?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses the frozen attempt after a lost provider response', async () => {
    const { checkout, stripe, organisationId, session } = await checkoutFixture();
    stripe.loseResponse = true;
    await expect(checkout()).rejects.toThrow('lost response');
    await client.db.update(users).set({ email: `new-${organisationId}@example.invalid` }).where(eq(users.id, session.userId));
    await expect(checkout('ANNUAL', 1)).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    await expect(checkout('MONTHLY', 1)).resolves.toMatchObject({ id: stripe.checkoutSessions.values().next().value?.id });
    expect(stripe.checkoutRequests[1]).toEqual(stripe.checkoutRequests[0]);
    expect(stripe.checkoutRequests[0]?.organisationId).toBe(organisationId);
    expect(stripe.checkoutSessions.size).toBe(1);
  });

  it('releases only a definitively rejected unbound attempt and retries with a fresh provider window', async () => {
    const { checkout, stripe, advance } = await checkoutFixture();
    stripe.loseBeforeCreate = true;
    await expect(checkout()).rejects.toThrow('lost response before execution');
    const firstAttempt = stripe.checkoutRequests[0]!;

    advance(2 * 60 * 60);
    stripe.rejectBeforeCreate = true;
    await expect(checkout()).resolves.toBeDefined();

    expect(stripe.checkoutRequests).toHaveLength(3);
    expect(stripe.checkoutRequests[1]).toEqual(firstAttempt);
    expect(stripe.checkoutRequests[2]?.attemptId).not.toBe(firstAttempt.attemptId);
    expect(stripe.checkoutRequests[2]?.expiresAt.getTime()).toBeGreaterThan(
      firstAttempt.expiresAt.getTime()
    );
    expect(stripe.checkoutSessions.size).toBe(1);
  });

  it('reuses the provider Session after the first local bind fails', async () => {
    const { checkout, stripe, repository } = await checkoutFixture();
    const bind = vi.spyOn(repository, 'recordCheckoutSession').mockRejectedValueOnce(new Error('bind failed'));
    await expect(checkout()).rejects.toThrow('bind failed');
    bind.mockRestore();
    await expect(checkout('ANNUAL', 1)).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    await expect(checkout()).resolves.toMatchObject({ id: stripe.checkoutSessions.values().next().value?.id });
    expect(stripe.checkoutSessions.size).toBe(1);
  });

  it('holds an elapsed attempt until read-only Stripe evidence confirms expiry', async () => {
    const { checkout, stripe, advance } = await checkoutFixture();
    const monthly = await checkout();
    advance(86_400);
    await expect(checkout('ANNUAL', 1)).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    const session = stripe.checkoutSessions.values().next().value!;
    session.status = 'expired';
    session.url = null;
    const annual = await checkout('ANNUAL', 1);
    expect(annual.id).not.toBe(monthly.id);
    expect(stripe.checkoutSessions.size).toBe(2);
  });

  it('releases an unknown Session only after its signed expiry arrives', async () => {
    const { checkout, stripe, advance, webhook } = await checkoutFixture();
    stripe.loseResponse = true;
    await expect(checkout()).rejects.toThrow('lost response');
    const request = stripe.checkoutRequests[0]!;
    advance(86_400);
    await expect(checkout()).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    const event = attemptCheckoutEvent(request, stripe.checkoutSessions.values().next().value!.id, 'expired');
    await expect(webhook(event)).resolves.toBe('APPLIED');
    await expect(webhook(event)).resolves.toBe('DUPLICATE');
    await expect(checkout('ANNUAL')).resolves.toBeDefined();
    expect(stripe.checkoutSessions.size).toBe(2);
  });

  it.each(['checkout-first', 'lifecycle-first'])('binds an episode in %s order and requires both terminal signals', async (order) => {
    const { checkout, stripe, organisationId, webhook } = await checkoutFixture();
    const hosted = await checkout();
    const request = stripe.checkoutRequests[0]!;
    const complete = attemptCheckoutEvent(request, hosted.id, 'complete');
    const active = attemptLifecycleEvent(request, 'active');
    const canceled = attemptLifecycleEvent(request, 'canceled');
    const session = stripe.checkoutSessions.values().next().value!;
    if (order === 'checkout-first') {
      await expect(webhook(complete)).resolves.toBe('APPLIED');
      await expect(webhook(active)).resolves.toBe('APPLIED');
      await expect(checkout('ANNUAL')).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
      await expect(webhook(canceled)).resolves.toBe('APPLIED');
    } else {
      await expect(webhook(active)).resolves.toBe('APPLIED');
      await expect(webhook(canceled)).resolves.toBe('APPLIED');
      await expect(checkout('ANNUAL')).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
      await expect(webhook(complete)).resolves.toBe('APPLIED');
    }
    session.status = 'complete';
    session.url = null;
    await expect(webhook(complete)).resolves.toBe('DUPLICATE');
    const next = await checkout('ANNUAL', 1);
    expect(next.id).not.toBe(hosted.id);
    expect(stripe.checkoutRequests.at(-1)?.stripeCustomerId).toBe('cus_' + organisationId);
    await expect(webhook(attemptCheckoutEvent(request, hosted.id, 'expired'))).resolves.toBe('REJECTED');
    const [row] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(row).toMatchObject({
      stripeSubscriptionId: 'sub_' + organisationId,
      trustedStripeProviderStatus: 'canceled',
      initialCardInvoiceId: 'in_' + organisationId
    });
  });

  it('keeps a lifecycle-bound subscription fenced through a delayed Session expiry', async () => {
    const { checkout, stripe, webhook } = await checkoutFixture();
    const hosted = await checkout();
    const request = stripe.checkoutRequests[0]!;
    const paused = attemptLifecycleEvent(request, 'paused');
    const canceled = attemptLifecycleEvent(request, 'canceled');
    await expect(webhook(paused)).resolves.toBe('APPLIED');
    const expired = attemptCheckoutEvent(request, hosted.id, 'expired');
    await expect(webhook(expired)).resolves.toBe('APPLIED');
    await expect(checkout('ANNUAL')).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    // Stripe may emit two distinct lifecycle events in the same second.
    await expect(webhook({ ...canceled, created: paused.created })).resolves.toBe('APPLIED');
    await expect(checkout('ANNUAL')).resolves.toBeDefined();
  });

  it('rejects evidence with mismatched organisation, attempt, Session, customer or cadence', async () => {
    const { checkout, stripe, organisationId, webhook } = await checkoutFixture();
    const other = await checkoutFixture();
    const expectedCustomer = 'cus_' + organisationId;
    await client.db.update(subscriptions).set({ stripeCustomerId: expectedCustomer }).where(eq(subscriptions.organisationId, organisationId));
    const hosted = await checkout();
    const request = stripe.checkoutRequests[0]!;
    const checkoutEvent = attemptCheckoutEvent(request, hosted.id, 'complete');
    const checkoutObject = checkoutEvent.data.object as Record<string, unknown>;
    const metadata = checkoutObject.metadata as Record<string, unknown>;
    const changes = [
      { client_reference_id: other.organisationId, metadata: { ...metadata, organisation_id: other.organisationId } },
      { metadata: { organisation_id: request.organisationId, plan_code: 'SOLO_AU_2000' } },
      { metadata: { ...metadata, checkout_attempt_id: randomUUID() } },
      { id: 'cs_wrong' },
      { customer: 'cus_wrong' },
      { metadata: { ...metadata, billing_cadence: 'ANNUAL' } }
    ];
    for (const change of changes) {
      await expect(webhook({ ...checkoutEvent, id: 'evt_' + randomUUID(), data: { object: { ...checkoutObject, ...change } } })).resolves.toBe('REJECTED');
    }
    const lifecycle = attemptLifecycleEvent({ ...request, billingCadence: 'ANNUAL', priceId: 'price_solo_annual' }, 'active');
    await expect(webhook(lifecycle)).resolves.toBe('REJECTED');
    await expect(checkout('ANNUAL')).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });
    const [row] = await client.db.select().from(subscriptions).where(eq(subscriptions.organisationId, organisationId));
    expect(row?.stripeSubscriptionId).toBeNull();
    await expect(webhook(checkoutEvent)).resolves.toBe('APPLIED');
  });

  it('does not accept contradictory evidence for an attempt resolved by a racing webhook', async () => {
    const { checkout, stripe, repository, webhook } = await checkoutFixture();
    const hosted = await checkout();
    const request = stripe.checkoutRequests[0]!;
    const expired = attemptCheckoutEvent(request, hosted.id, 'expired');
    await expect(webhook(expired)).resolves.toBe('APPLIED');

    await expect(repository.recordCheckoutSession({
      id: hosted.id,
      organisationId: request.organisationId,
      attemptId: request.attemptId,
      billingCadence: 'ANNUAL',
      expiresAt: new Date(request.expiresAt.getTime() + 60_000),
      status: 'open',
      stripeCustomerId: 'cus_contradictory',
      stripeSubscriptionId: 'sub_contradictory'
    })).resolves.toBe('FENCED');
  });

  it('does not let another tenant claim a customer already observed on a different attempt', async () => {
    const first = await checkoutFixture();
    const second = await checkoutFixture();
    await first.checkout();
    const providerSession = first.stripe.checkoutSessions.values().next().value!;
    providerSession.status = 'complete';
    providerSession.url = null;
    providerSession.stripeCustomerId = 'cus_' + first.organisationId;
    providerSession.stripeSubscriptionId = 'sub_' + first.organisationId;
    await expect(first.checkout()).rejects.toMatchObject({ code: 'CHECKOUT_ATTEMPT_CONFLICT' });

    const hosted = await second.checkout();
    const request = second.stripe.checkoutRequests[0]!;
    const event = attemptCheckoutEvent(request, hosted.id, 'complete');
    const object = event.data.object as Record<string, unknown>;
    await expect(second.webhook({ ...event, data: { object: {
      ...object,
      customer: providerSession.stripeCustomerId
    } } })).resolves.toBe('REJECTED');
  });

  it('keeps a paused or unverified cancelled predecessor fenced', async () => {
    const { checkout, stripe, organisationId } = await checkoutFixture();
    await client.db.update(subscriptions).set({
      status: 'CANCELLED',
      stripeProviderStatus: 'paused',
      stripeCustomerId: 'cus_' + organisationId,
      stripeSubscriptionId: 'sub_' + organisationId
    }).where(eq(subscriptions.organisationId, organisationId));
    await expect(checkout()).rejects.toMatchObject({ code: 'CHECKOUT_NOT_AVAILABLE' });
    await client.db.update(subscriptions).set({ status: 'CANCELLED' }).where(eq(subscriptions.organisationId, organisationId));
    await expect(checkout()).rejects.toMatchObject({ code: 'CHECKOUT_NOT_AVAILABLE' });
    expect(stripe.checkoutSessions.size).toBe(0);
  });
});

const attemptCheckoutEvent = (
  request: SoloCheckoutRequest,
  stripeSessionId: string,
  status: 'complete' | 'expired'
): StripeWebhookEvent => ({
  id: 'evt_' + randomUUID(),
  type: status === 'complete' ? 'checkout.session.completed' : 'checkout.session.expired',
  created: Math.floor(now.getTime() / 1000) + 30,
  data: {
    object: {
      object: 'checkout.session',
      id: stripeSessionId,
      mode: 'subscription',
      status,
      expires_at: request.expiresAt.getTime() / 1000,
      payment_status: status === 'complete' ? 'paid' : 'unpaid',
      currency: 'aud',
      amount_total: status === 'complete' ? 32890 : null,
      payment_method_types: ['card'],
      client_reference_id: request.organisationId,
      metadata: {
        organisation_id: request.organisationId,
        plan_code: 'SOLO_AU_2000',
        checkout_attempt_id: request.attemptId,
        billing_cadence: request.billingCadence
      },
      customer: status === 'complete' ? 'cus_' + request.organisationId : request.stripeCustomerId ?? null,
      subscription: status === 'complete' ? 'sub_' + request.organisationId : null,
      invoice: status === 'complete' ? 'in_' + request.organisationId : null
    }
  }
});

const attemptLifecycleEvent = (request: SoloCheckoutRequest, status: 'active' | 'canceled' | 'paused'): StripeWebhookEvent => {
  currentOrganisationId = request.organisationId;
  const event = stripeEvent({
    id: 'evt_' + randomUUID(),
    created: Math.floor(now.getTime() / 1000) + (status === 'canceled' ? 60 : 15),
    status,
    priceId: request.priceId
  });
  const object = event.data.object as { metadata: Record<string, unknown>; items: { data: [{ price: { recurring: { interval: string } } }] } };
  object.metadata.checkout_attempt_id = request.attemptId;
  object.metadata.billing_cadence = request.billingCadence;
  object.items.data[0].price.recurring.interval = request.billingCadence === 'ANNUAL' ? 'year' : 'month';
  return event;
};
