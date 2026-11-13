import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  billingCases,
  createDatabase,
  memberships,
  migrateDatabase,
  organisations,
  retiredStripeSubscriptions,
  subscriptionEvents,
  subscriptions,
  transactionalEmailOutbox,
  users
} from '@bc5000/db';

import { createPostgresSubscriptionRepository } from './subscription-repository.js';
import type { StripeOperationalEventInput } from './subscription-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const clockNow = new Date('2026-11-12T01:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const addMember = async (
  organisationId: string,
  input: {
    role?: 'ADMIN' | 'OPERATOR';
    disabledMembership?: boolean;
    disabledUser?: boolean;
    email?: string;
  } = {}
) => {
  const userId = randomUUID();
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: input.email ?? `${userId}@example.invalid`,
    displayName: 'Billing member',
    disabledAt: input.disabledUser ? clockNow : null
  });
  await client.db.insert(memberships).values({
    organisationId,
    userId,
    role: input.role ?? 'ADMIN',
    disabledAt: input.disabledMembership ? clockNow : null
  });
  return userId;
};

const seedOrganisation = async (input: { activeAdmins?: number } = {}) => {
  const organisationId = randomUUID();
  const stripeCustomerId = `cus_${randomUUID()}`;
  const stripeSubscriptionId = `sub_${randomUUID()}`;
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Payment operations test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: 'ACTIVE',
    stripeProviderStatus: 'active',
    trustedStripeProviderStatus: 'active',
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z')
  });
  const activeAdminIds: string[] = [];
  for (let index = 0; index < (input.activeAdmins ?? 2); index += 1) {
    activeAdminIds.push(
      await addMember(organisationId, {
        email: ` ADMIN-${index}-${organisationId}@Example.Invalid `
      })
    );
  }
  await addMember(organisationId, { role: 'OPERATOR' });
  await addMember(organisationId, { disabledMembership: true });
  await addMember(organisationId, { disabledUser: true });
  return {
    organisationId,
    stripeCustomerId,
    stripeSubscriptionId,
    activeAdminIds
  };
};

const operationalEvent = (
  input: Partial<StripeOperationalEventInput> &
    Pick<StripeOperationalEventInput, 'eventId' | 'providerObjectId'>
): StripeOperationalEventInput => ({
  eventType: 'invoice.payment_failed',
  eventCreatedAt: new Date('2026-11-12T00:00:00.000Z'),
  payloadHash: 'a'.repeat(64),
  stripeCustomerId: 'cus_missing',
  stripeSubscriptionId: 'sub_missing',
  providerObjectType: 'INVOICE',
  providerStatus: 'open',
  amountMinor: 12_345,
  currency: 'aud',
  caseKind: 'PAYMENT_FAILURE',
  targetStatus: 'OPEN',
  suspensionPolicy: 'CURRENT_ONLY',
  heldTemplate: 'PAYMENT_FAILED',
  resolveExistingOnly: false,
  ...input,
  eventId: input.eventId,
  providerObjectId: input.providerObjectId
});

const noticeIdempotencyKey = (
  eventId: string,
  template: StripeOperationalEventInput['heldTemplate'],
  recipient: string
) =>
  `stripe:${eventId}:${template}:v1:${createHash('sha256').update(recipient).digest('hex')}`;

const repository = () =>
  createPostgresSubscriptionRepository(client.db, { now: () => clockNow });

describe('operational Stripe event persistence', () => {
  it('classifies durable event replays by both Stripe event ID and payload hash', async () => {
    const seeded = await seedOrganisation();
    const eventId = `evt_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;
    await expect(
      repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: seeded.stripeSubscriptionId,
          payloadHash: 'a'.repeat(64)
        })
      )
    ).resolves.toBe('APPLIED');

    await expect(
      repository().lookupEventReplay({
        eventId,
        payloadHash: 'a'.repeat(64)
      })
    ).resolves.toBe('DUPLICATE');
    await expect(
      repository().lookupEventReplay({
        eventId,
        payloadHash: 'b'.repeat(64)
      })
    ).resolves.toBe('HASH_MISMATCH');
    await expect(
      repository().lookupEventReplay({
        eventId: `evt_${randomUUID()}`,
        payloadHash: 'a'.repeat(64)
      })
    ).resolves.toBe('ABSENT');
    await expect(
      repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: seeded.stripeSubscriptionId,
          payloadHash: 'b'.repeat(64)
        })
      )
    ).rejects.toThrow('STRIPE_EVENT_PAYLOAD_MISMATCH');
  });

  it('atomically suspends a current payment failure, fans out held notices, deduplicates, and never reactivates on recovery', async () => {
    const seeded = await seedOrganisation();
    const eventId = `evt_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;
    const failed = operationalEvent({
      eventId,
      providerObjectId: invoiceId,
      stripeCustomerId: seeded.stripeCustomerId,
      stripeSubscriptionId: seeded.stripeSubscriptionId
    });

    await expect(repository().applyOperationalEvent(failed)).resolves.toBe('APPLIED');
    await expect(repository().applyOperationalEvent(failed)).resolves.toBe('DUPLICATE');

    const [paymentCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, invoiceId));
    const held = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(eq(transactionalEmailOutbox.billingCaseId, paymentCase!.id));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    const providerEvents = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId));

    expect(paymentCase).toMatchObject({
      organisationId: seeded.organisationId,
      status: 'OPEN',
      subscriptionRelation: 'CURRENT',
      blocksSending: true
    });
    expect(held).toHaveLength(2);
    expect(held.map((row) => row.recipient).sort()).toEqual(
      [0, 1].map((index) => `admin-${index}-${seeded.organisationId}@example.invalid`).sort()
    );
    expect(held.every((row) => row.status === 'HELD' && row.attempts === 0)).toBe(true);
    expect(organisation).toMatchObject({
      platformStatus: 'SUSPENDED',
      platformStatusVersion: 1,
      sendMode: 'live',
      rolloutScope: 'CUSTOMER',
      liveSendAcknowledged: true
    });
    expect(providerEvents).toHaveLength(1);

    const recoveredId = `evt_${randomUUID()}`;
    await expect(
      repository().applyOperationalEvent({
        ...failed,
        eventId: recoveredId,
        eventType: 'invoice.paid',
        eventCreatedAt: new Date('2026-11-12T00:01:00.000Z'),
        providerStatus: 'paid',
        amountMinor: 0,
        targetStatus: 'RESOLVED',
        suspensionPolicy: 'NEVER',
        heldTemplate: 'PAYMENT_RECOVERED',
        resolveExistingOnly: true
      })
    ).resolves.toBe('APPLIED');
    const [resolved] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.id, paymentCase!.id));
    const [stillSuspended] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    const recoveryNotices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(
        and(
          eq(transactionalEmailOutbox.billingCaseId, paymentCase!.id),
          eq(transactionalEmailOutbox.template, 'PAYMENT_RECOVERED')
        )
      );
    expect(resolved).toMatchObject({ status: 'RESOLVED', blocksSending: false });
    expect(stillSuspended?.platformStatus).toBe('SUSPENDED');
    expect(recoveryNotices).toHaveLength(2);

    await expect(
      repository().applyOperationalEvent({
        ...failed,
        eventId: `evt_${randomUUID()}`,
        eventCreatedAt: new Date('2026-11-12T00:00:30.000Z')
      })
    ).resolves.toBe('IGNORED_OUT_OF_ORDER');
    const [afterOlderRisk] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.id, paymentCase!.id));
    expect(afterOlderRisk?.status).toBe('RESOLVED');
  });

  it('normalizes and deduplicates valid administrators while auditing invalid notice recipients', async () => {
    const seeded = await seedOrganisation({ activeAdmins: 0 });
    const duplicateRecipient = `billing.owner+${seeded.organisationId}@example.invalid`;
    const blankRecipient = [...randomUUID()]
      .map((character) => [' ', '\t', '\r', '\n', '\u2000'][character.charCodeAt(0) % 5])
      .join('');
    await addMember(seeded.organisationId, {
      email: ` ${duplicateRecipient.toUpperCase()} `
    });
    await addMember(seeded.organisationId, {
      email: duplicateRecipient
    });
    await addMember(seeded.organisationId, { email: blankRecipient });
    await addMember(seeded.organisationId, {
      email: `${seeded.organisationId}${'a'.repeat(285)}@example.invalid`
    });
    const eventId = `evt_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;

    await expect(
      repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: seeded.stripeSubscriptionId
        })
      )
    ).resolves.toBe('APPLIED');

    const [billingCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, invoiceId));
    const notices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(eq(transactionalEmailOutbox.billingCaseId, billingCase!.id));
    const audits = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));

    expect(notices.map((notice) => notice.recipient)).toEqual([
      duplicateRecipient
    ]);
    expect(
      audits.filter(
        (audit) => audit.eventType === 'BILLING_NOTICE_RECIPIENT_INVALID'
      )
    ).toHaveLength(2);
    expect(
      audits.filter(
        (audit) => audit.eventType === 'BILLING_NOTICE_RECIPIENT_DUPLICATE'
      )
    ).toHaveLength(1);
    expect(organisation?.platformStatus).toBe('SUSPENDED');
  });

  it('keeps the billing case and suspension when a pre-existing notice key collides', async () => {
    const seeded = await seedOrganisation({ activeAdmins: 0 });
    const recipient = `billing.owner+${seeded.organisationId}@example.invalid`;
    await addMember(seeded.organisationId, { email: recipient });
    const seedOpenedAt = new Date('2026-11-11T22:00:00.000Z');
    const [seedCase] = await client.db
      .insert(billingCases)
      .values({
        organisationId: seeded.organisationId,
        kind: 'REFUND',
        status: 'REVIEW_REQUIRED',
        providerObjectType: 'CHARGE',
        providerObjectId: `ch_${randomUUID()}`,
        providerStatus: 'partially_refunded',
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        subscriptionRelation: 'CURRENT',
        amountMinor: 100,
        currency: 'aud',
        blocksSending: false,
        latestProviderEventId: `evt_${randomUUID()}`,
        latestProviderEventCreatedAt: seedOpenedAt,
        openedAt: seedOpenedAt
      })
      .returning({ id: billingCases.id });
    const eventId = `evt_${randomUUID()}`;
    await client.db.insert(transactionalEmailOutbox).values({
      organisationId: seeded.organisationId,
      billingCaseId: seedCase!.id,
      recipient,
      template: 'PAYMENT_FAILED',
      templateVersion: 1,
      renderData: { seededConflict: true },
      idempotencyKey: noticeIdempotencyKey(
        eventId,
        'PAYMENT_FAILED',
        recipient
      ),
      status: 'HELD'
    });
    const invoiceId = `in_${randomUUID()}`;

    await expect(
      repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: seeded.stripeSubscriptionId
        })
      )
    ).resolves.toBe('APPLIED');

    const [paymentCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, invoiceId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    const [providerEvent] = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId));
    const skipped = await client.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, seeded.organisationId),
          eq(auditEvents.eventType, 'BILLING_NOTICE_WRITE_SKIPPED')
        )
      );

    expect(paymentCase).toMatchObject({ status: 'OPEN', blocksSending: true });
    expect(organisation?.platformStatus).toBe('SUSPENDED');
    expect(providerEvent?.outcome).toBe('APPLIED');
    expect(skipped).toHaveLength(1);
  });

  it('accepts same-organisation retired ownership but rejects unknown and cross-customer ownership without durable evidence', async () => {
    const seeded = await seedOrganisation();
    const retiredId = `sub_retired_${randomUUID()}`;
    await client.db.insert(retiredStripeSubscriptions).values({
      stripeSubscriptionId: retiredId,
      organisationId: seeded.organisationId
    });
    const invoiceId = `in_${randomUUID()}`;
    await expect(
      repository().applyOperationalEvent(
        operationalEvent({
          eventId: `evt_${randomUUID()}`,
          providerObjectId: invoiceId,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: retiredId
        })
      )
    ).resolves.toBe('APPLIED');
    const [retiredCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, invoiceId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(retiredCase).toMatchObject({
      subscriptionRelation: 'RETIRED',
      blocksSending: false
    });
    expect(organisation?.platformStatus).toBe('ACTIVE');

    for (const [stripeSubscriptionId, stripeCustomerId] of [
      [`sub_unknown_${randomUUID()}`, seeded.stripeCustomerId],
      [retiredId, `cus_wrong_${randomUUID()}`]
    ] as const) {
      const rejectedEventId = `evt_${randomUUID()}`;
      await expect(
        repository().applyOperationalEvent(
          operationalEvent({
            eventId: rejectedEventId,
            providerObjectId: `in_${randomUUID()}`,
            stripeCustomerId,
            stripeSubscriptionId
          })
        )
      ).resolves.toBe('REJECTED');
      const stored = await client.db
        .select()
        .from(subscriptionEvents)
        .where(eq(subscriptionEvents.stripeEventId, rejectedEventId));
      expect(stored).toEqual([]);
    }
  });

  it('rejects a customer from one tenant paired with another tenant retired subscription without mutating either tenant', async () => {
    const first = await seedOrganisation();
    const second = await seedOrganisation();
    const retiredId = `sub_retired_${randomUUID()}`;
    await client.db.insert(retiredStripeSubscriptions).values({
      stripeSubscriptionId: retiredId,
      organisationId: second.organisationId
    });
    const eventId = `evt_${randomUUID()}`;

    await expect(
      repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: `in_${randomUUID()}`,
          stripeCustomerId: first.stripeCustomerId,
          stripeSubscriptionId: retiredId
        })
      )
    ).resolves.toBe('REJECTED');

    const organisationIds = [first.organisationId, second.organisationId];
    const cases = await client.db
      .select()
      .from(billingCases)
      .where(inArray(billingCases.organisationId, organisationIds));
    const notices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(inArray(transactionalEmailOutbox.organisationId, organisationIds));
    const organisationsAfter = await client.db
      .select()
      .from(organisations)
      .where(inArray(organisations.id, organisationIds));
    const events = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId));

    expect(cases).toEqual([]);
    expect(notices).toEqual([]);
    expect(organisationsAfter.every((row) => row.platformStatus === 'ACTIVE')).toBe(true);
    expect(events).toEqual([]);
  });

  it('accepts a replacement committed between the current and retired pre-lock ownership reads', async () => {
    const seeded = await seedOrganisation();
    const replacementId = `sub_replacement_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const blocker = await client.pool.connect();
    let committed = false;
    try {
      await blocker.query('begin');
      await blocker.query(
        'lock table retired_stripe_subscriptions in access exclusive mode'
      );
      const application = repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: seeded.stripeSubscriptionId
        })
      );

      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await client.pool.query<{ waiting: boolean }>(
          `select exists (
             select 1
             from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and state = 'active'
               and query ilike '%retired_stripe_subscriptions%'
           ) as waiting`
        );
        waiting = result.rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      await blocker.query(
        'update subscriptions set stripe_subscription_id = $1 where organisation_id = $2',
        [replacementId, seeded.organisationId]
      );
      await blocker.query(
        'insert into retired_stripe_subscriptions (stripe_subscription_id, organisation_id) values ($1, $2)',
        [seeded.stripeSubscriptionId, seeded.organisationId]
      );
      await blocker.query('commit');
      committed = true;

      await expect(application).resolves.toBe('APPLIED');
    } finally {
      if (!committed) await blocker.query('rollback');
      blocker.release();
    }

    const [billingCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, invoiceId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(billingCase).toMatchObject({
      subscriptionRelation: 'RETIRED',
      blocksSending: false
    });
    expect(organisation?.platformStatus).toBe('ACTIVE');
  });

  it('re-resolves a replaced current subscription as retired after the organisation lock is acquired', async () => {
    const seeded = await seedOrganisation();
    const replacementId = `sub_replacement_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const blocker = await client.pool.connect();
    let committed = false;
    try {
      await blocker.query('begin');
      await blocker.query(
        'select id from organisations where id = $1 for update',
        [seeded.organisationId]
      );
      const application = repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: seeded.stripeSubscriptionId
        })
      );

      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await client.pool.query<{ waiting: boolean }>(
          `select exists (
             select 1
             from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and state = 'active'
               and query ilike '%organisations%for update%'
           ) as waiting`
        );
        waiting = result.rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      await blocker.query(
        'update subscriptions set stripe_subscription_id = $1 where organisation_id = $2',
        [replacementId, seeded.organisationId]
      );
      await blocker.query(
        'insert into retired_stripe_subscriptions (stripe_subscription_id, organisation_id) values ($1, $2)',
        [seeded.stripeSubscriptionId, seeded.organisationId]
      );
      await blocker.query('commit');
      committed = true;

      await expect(application).resolves.toBe('APPLIED');
    } finally {
      if (!committed) await blocker.query('rollback');
      blocker.release();
    }

    const [billingCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, invoiceId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(billingCase).toMatchObject({
      subscriptionRelation: 'RETIRED',
      blocksSending: false
    });
    expect(organisation?.platformStatus).toBe('ACTIVE');
  });

  it('rejects a foreign retired owner committed while the current owner waits for its organisation lock', async () => {
    const currentOwner = await seedOrganisation();
    const foreignOwner = await seedOrganisation();
    const invoiceId = `in_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const blocker = await client.pool.connect();
    let committed = false;
    try {
      await blocker.query('begin');
      await blocker.query(
        'select id from organisations where id = $1 for update',
        [currentOwner.organisationId]
      );
      const application = repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: currentOwner.stripeCustomerId,
          stripeSubscriptionId: currentOwner.stripeSubscriptionId
        })
      );

      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await client.pool.query<{ waiting: boolean }>(
          `select exists (
             select 1
             from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and state = 'active'
               and query ilike '%organisations%for update%'
           ) as waiting`
        );
        waiting = result.rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      await blocker.query(
        'insert into retired_stripe_subscriptions (stripe_subscription_id, organisation_id) values ($1, $2)',
        [currentOwner.stripeSubscriptionId, foreignOwner.organisationId]
      );
      await blocker.query('commit');
      committed = true;

      await expect(application).resolves.toBe('REJECTED');
    } finally {
      if (!committed) await blocker.query('rollback');
      blocker.release();
    }

    const organisationIds = [
      currentOwner.organisationId,
      foreignOwner.organisationId
    ];
    const cases = await client.db
      .select()
      .from(billingCases)
      .where(inArray(billingCases.organisationId, organisationIds));
    const notices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(inArray(transactionalEmailOutbox.organisationId, organisationIds));
    const organisationsAfter = await client.db
      .select()
      .from(organisations)
      .where(inArray(organisations.id, organisationIds));
    const events = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId));

    expect(cases).toEqual([]);
    expect(notices).toEqual([]);
    expect(organisationsAfter.every((row) => row.platformStatus === 'ACTIVE')).toBe(
      true
    );
    expect(events).toEqual([]);
  });

  it('rejects a foreign retired owner committed after ownership reads while waiting on the billing case', async () => {
    const currentOwner = await seedOrganisation();
    const foreignOwner = await seedOrganisation();
    const invoiceId = `in_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const previousEventId = `evt_${randomUUID()}`;
    const openedAt = new Date('2026-11-11T22:00:00.000Z');
    const [seedCase] = await client.db
      .insert(billingCases)
      .values({
        organisationId: currentOwner.organisationId,
        kind: 'PAYMENT_FAILURE',
        status: 'RESOLVED',
        providerObjectType: 'INVOICE',
        providerObjectId: invoiceId,
        providerStatus: 'paid',
        stripeSubscriptionId: currentOwner.stripeSubscriptionId,
        subscriptionRelation: 'CURRENT',
        amountMinor: 0,
        currency: 'aud',
        blocksSending: false,
        latestProviderEventId: previousEventId,
        latestProviderEventCreatedAt: openedAt,
        openedAt,
        resolvedAt: openedAt
      })
      .returning({ id: billingCases.id });
    const blocker = await client.pool.connect();
    let committed = false;
    try {
      await blocker.query('begin');
      await blocker.query('select id from billing_cases where id = $1 for update', [
        seedCase!.id
      ]);
      const application = repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          providerObjectId: invoiceId,
          stripeCustomerId: currentOwner.stripeCustomerId,
          stripeSubscriptionId: currentOwner.stripeSubscriptionId
        })
      );

      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await client.pool.query<{ waiting: boolean }>(
          `select exists (
             select 1
             from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and state = 'active'
               and query ilike '%billing_cases%for update%'
           ) as waiting`
        );
        waiting = result.rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      const lockProbe = await client.pool.connect();
      try {
        await lockProbe.query('begin');
        const lockResult = await lockProbe.query<{ acquired: boolean }>(
          `select pg_try_advisory_xact_lock(
             hashtextextended($1, 0::bigint)
           ) as acquired`,
          [currentOwner.stripeSubscriptionId]
        );
        expect(lockResult.rows[0]?.acquired).toBe(false);
        await lockProbe.query('rollback');
      } finally {
        lockProbe.release();
      }

      await blocker.query(
        'insert into retired_stripe_subscriptions (stripe_subscription_id, organisation_id) values ($1, $2)',
        [currentOwner.stripeSubscriptionId, foreignOwner.organisationId]
      );
      await blocker.query('commit');
      committed = true;

      await expect(application).resolves.toBe('REJECTED');
    } finally {
      if (!committed) await blocker.query('rollback');
      blocker.release();
    }

    const [caseAfter] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.id, seedCase!.id));
    const notices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(eq(transactionalEmailOutbox.billingCaseId, seedCase!.id));
    const organisationsAfter = await client.db
      .select()
      .from(organisations)
      .where(
        inArray(organisations.id, [
          currentOwner.organisationId,
          foreignOwner.organisationId
        ])
      );
    const events = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId));

    expect(caseAfter).toMatchObject({
      status: 'RESOLVED',
      blocksSending: false,
      latestProviderEventId: previousEventId
    });
    expect(notices).toEqual([]);
    expect(organisationsAfter.every((row) => row.platformStatus === 'ACTIVE')).toBe(
      true
    );
    expect(events).toEqual([]);
  });

  it('records cumulative refunds for review without suspending the organisation', async () => {
    const seeded = await seedOrganisation();
    const chargeId = `ch_${randomUUID()}`;
    const base = operationalEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'charge.refunded',
      providerObjectType: 'CHARGE',
      providerObjectId: chargeId,
      providerStatus: 'partially_refunded',
      amountMinor: 2_000,
      caseKind: 'REFUND',
      targetStatus: 'REVIEW_REQUIRED',
      suspensionPolicy: 'NEVER',
      heldTemplate: 'REFUND_RECORDED',
      stripeCustomerId: seeded.stripeCustomerId,
      stripeSubscriptionId: seeded.stripeSubscriptionId
    });
    await expect(repository().applyOperationalEvent(base)).resolves.toBe('APPLIED');
    await expect(
      repository().applyOperationalEvent({
        ...base,
        eventId: `evt_${randomUUID()}`,
        eventCreatedAt: new Date('2026-11-12T00:05:00.000Z'),
        providerStatus: 'refunded',
        amountMinor: 12_345
      })
    ).resolves.toBe('APPLIED');
    const [refundCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, chargeId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(refundCase).toMatchObject({
      kind: 'REFUND',
      status: 'REVIEW_REQUIRED',
      amountMinor: 12_345,
      blocksSending: false
    });
    expect(organisation?.platformStatus).toBe('ACTIVE');
  });

  it('keeps the greater cumulative refund amount at equal provider timestamps regardless of arrival order', async () => {
    const createdAt = new Date('2026-11-12T00:07:00.000Z');
    const applyPair = async (firstAmount: number, secondAmount: number) => {
      const seeded = await seedOrganisation({ activeAdmins: 1 });
      const chargeId = `ch_${randomUUID()}`;
      const base = operationalEvent({
        eventId: `evt_${randomUUID()}`,
        eventType: 'charge.refunded',
        eventCreatedAt: createdAt,
        providerObjectType: 'CHARGE',
        providerObjectId: chargeId,
        providerStatus: 'partially_refunded',
        amountMinor: firstAmount,
        caseKind: 'REFUND',
        targetStatus: 'REVIEW_REQUIRED',
        suspensionPolicy: 'NEVER',
        heldTemplate: 'REFUND_RECORDED',
        stripeCustomerId: seeded.stripeCustomerId,
        stripeSubscriptionId: seeded.stripeSubscriptionId
      });
      await repository().applyOperationalEvent(base);
      await repository().applyOperationalEvent({
        ...base,
        eventId: `evt_${randomUUID()}`,
        amountMinor: secondAmount,
        providerStatus: secondAmount === 12_345 ? 'refunded' : 'partially_refunded'
      });
      const [billingCase] = await client.db
        .select()
        .from(billingCases)
        .where(eq(billingCases.providerObjectId, chargeId));
      const notices = await client.db
        .select()
        .from(transactionalEmailOutbox)
        .where(eq(transactionalEmailOutbox.billingCaseId, billingCase!.id));
      return {
        amountMinor: billingCase!.amountMinor,
        noticeAmounts: notices.map((notice) => notice.renderData.amountMinor)
      };
    };

    await expect(applyPair(2_000, 12_345)).resolves.toEqual({
      amountMinor: 12_345,
      noticeAmounts: [12_345]
    });
    await expect(applyPair(12_345, 2_000)).resolves.toEqual({
      amountMinor: 12_345,
      noticeAmounts: [12_345]
    });
  });

  it('uses risk precedence at equal timestamps and never reactivates a resolved dispute', async () => {
    const seeded = await seedOrganisation();
    const disputeId = `dp_${randomUUID()}`;
    const createdAt = new Date('2026-11-12T00:10:00.000Z');
    const opened = operationalEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'charge.dispute.created',
      eventCreatedAt: createdAt,
      providerObjectType: 'DISPUTE',
      providerObjectId: disputeId,
      providerStatus: 'needs_response',
      caseKind: 'DISPUTE',
      targetStatus: 'OPEN',
      suspensionPolicy: 'ALWAYS',
      heldTemplate: 'DISPUTE_OPENED',
      stripeCustomerId: seeded.stripeCustomerId,
      stripeSubscriptionId: seeded.stripeSubscriptionId
    });
    const closed = {
      ...opened,
      eventId: `evt_${randomUUID()}`,
      eventType: 'charge.dispute.closed' as const,
      providerStatus: 'won',
      targetStatus: 'RESOLVED' as const,
      suspensionPolicy: 'NEVER' as const,
      heldTemplate: 'DISPUTE_CLOSED' as const
    };
    await expect(repository().applyOperationalEvent(closed)).resolves.toBe('APPLIED');
    await expect(repository().applyOperationalEvent(opened)).resolves.toBe('APPLIED');
    const [riskWins] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, disputeId));
    expect(riskWins).toMatchObject({ status: 'OPEN', blocksSending: true });

    await expect(
      repository().applyOperationalEvent({
        ...closed,
        eventId: `evt_${randomUUID()}`,
        eventCreatedAt: new Date('2026-11-12T00:11:00.000Z')
      })
    ).resolves.toBe('APPLIED');
    const [resolved] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, disputeId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(resolved).toMatchObject({ status: 'RESOLVED', blocksSending: false });
    expect(organisation?.platformStatus).toBe('SUSPENDED');

    const secondDisputeId = `dp_${randomUUID()}`;
    const secondOpened = {
      ...opened,
      eventId: `evt_${randomUUID()}`,
      providerObjectId: secondDisputeId
    };
    await expect(repository().applyOperationalEvent(secondOpened)).resolves.toBe(
      'APPLIED'
    );
    await expect(
      repository().applyOperationalEvent({
        ...closed,
        eventId: `evt_${randomUUID()}`,
        providerObjectId: secondDisputeId
      })
    ).resolves.toBe('IGNORED_OUT_OF_ORDER');
    const [secondRiskWins] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, secondDisputeId));
    expect(secondRiskWins).toMatchObject({ status: 'OPEN', blocksSending: true });
  });

  it('keeps identical dispute case and held-notice outcomes for either same-second arrival order', async () => {
    const createdAt = new Date('2026-11-12T00:15:00.000Z');
    const applyOrder = async (closedFirst: boolean) => {
      const seeded = await seedOrganisation({ activeAdmins: 1 });
      const disputeId = `dp_${randomUUID()}`;
      const opened = operationalEvent({
        eventId: `evt_${randomUUID()}`,
        eventType: 'charge.dispute.created',
        eventCreatedAt: createdAt,
        providerObjectType: 'DISPUTE',
        providerObjectId: disputeId,
        providerStatus: 'needs_response',
        caseKind: 'DISPUTE',
        targetStatus: 'OPEN',
        suspensionPolicy: 'ALWAYS',
        heldTemplate: 'DISPUTE_OPENED',
        stripeCustomerId: seeded.stripeCustomerId,
        stripeSubscriptionId: seeded.stripeSubscriptionId
      });
      const closed = {
        ...opened,
        eventId: `evt_${randomUUID()}`,
        eventType: 'charge.dispute.closed' as const,
        providerStatus: 'won',
        targetStatus: 'RESOLVED' as const,
        suspensionPolicy: 'NEVER' as const,
        heldTemplate: 'DISPUTE_CLOSED' as const
      };
      for (const event of closedFirst ? [closed, opened] : [opened, closed]) {
        await repository().applyOperationalEvent(event);
      }
      const [billingCase] = await client.db
        .select()
        .from(billingCases)
        .where(eq(billingCases.providerObjectId, disputeId));
      const notices = await client.db
        .select()
        .from(transactionalEmailOutbox)
        .where(eq(transactionalEmailOutbox.billingCaseId, billingCase!.id));
      return {
        status: billingCase!.status,
        blocksSending: billingCase!.blocksSending,
        providerStatus: billingCase!.providerStatus,
        noticeTemplates: notices.map((notice) => notice.template).sort()
      };
    };

    const closedThenOpened = await applyOrder(true);
    const openedThenClosed = await applyOrder(false);
    expect(closedThenOpened).toEqual(openedThenClosed);
    expect(closedThenOpened).toEqual({
      status: 'OPEN',
      blocksSending: true,
      providerStatus: 'needs_response',
      noticeTemplates: ['DISPUTE_OPENED']
    });
  });

  it('suspends retired disputes, records lost closures as blocking review, and audits a missing recipient', async () => {
    const seeded = await seedOrganisation({ activeAdmins: 0 });
    const retiredId = `sub_retired_${randomUUID()}`;
    await client.db.insert(retiredStripeSubscriptions).values({
      stripeSubscriptionId: retiredId,
      organisationId: seeded.organisationId
    });
    const disputeId = `dp_${randomUUID()}`;
    const base = operationalEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'charge.dispute.created',
      providerObjectType: 'DISPUTE',
      providerObjectId: disputeId,
      providerStatus: 'under_review',
      caseKind: 'DISPUTE',
      targetStatus: 'OPEN',
      suspensionPolicy: 'ALWAYS',
      heldTemplate: 'DISPUTE_OPENED',
      stripeCustomerId: seeded.stripeCustomerId,
      stripeSubscriptionId: retiredId
    });
    await expect(repository().applyOperationalEvent(base)).resolves.toBe('APPLIED');
    await expect(
      repository().applyOperationalEvent({
        ...base,
        eventId: `evt_${randomUUID()}`,
        eventType: 'charge.dispute.closed',
        eventCreatedAt: new Date('2026-11-12T00:20:00.000Z'),
        providerStatus: 'lost',
        targetStatus: 'REVIEW_REQUIRED',
        heldTemplate: 'DISPUTE_CLOSED'
      })
    ).resolves.toBe('APPLIED');
    const [disputeCase] = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, disputeId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    const notices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(eq(transactionalEmailOutbox.billingCaseId, disputeCase!.id));
    const recipientAudits = await client.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, seeded.organisationId),
          eq(auditEvents.eventType, 'BILLING_NOTICE_RECIPIENT_MISSING')
        )
      );
    expect(disputeCase).toMatchObject({
      subscriptionRelation: 'RETIRED',
      status: 'REVIEW_REQUIRED',
      blocksSending: true
    });
    expect(organisation?.platformStatus).toBe('SUSPENDED');
    expect(notices).toEqual([]);
    expect(recipientAudits).toHaveLength(2);
  });

  it('records a routine paid invoice event without creating a case or notice', async () => {
    const seeded = await seedOrganisation();
    const eventId = `evt_${randomUUID()}`;
    await expect(
      repository().applyOperationalEvent(
        operationalEvent({
          eventId,
          eventType: 'invoice.paid',
          providerObjectId: `in_${randomUUID()}`,
          providerStatus: 'paid',
          amountMinor: 0,
          targetStatus: 'RESOLVED',
          suspensionPolicy: 'NEVER',
          heldTemplate: 'PAYMENT_RECOVERED',
          resolveExistingOnly: true,
          stripeCustomerId: seeded.stripeCustomerId,
          stripeSubscriptionId: seeded.stripeSubscriptionId
        })
      )
    ).resolves.toBe('APPLIED');
    const cases = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.organisationId, seeded.organisationId));
    const notices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(eq(transactionalEmailOutbox.organisationId, seeded.organisationId));
    const events = await client.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId));
    expect(cases).toEqual([]);
    expect(notices).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('uses a newer routine paid invoice as ordering evidence against an older payment failure', async () => {
    const seeded = await seedOrganisation();
    const invoiceId = `in_${randomUUID()}`;
    const paid = operationalEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'invoice.paid',
      eventCreatedAt: new Date('2026-11-12T00:40:00.000Z'),
      providerObjectId: invoiceId,
      providerStatus: 'paid',
      amountMinor: 0,
      targetStatus: 'RESOLVED',
      suspensionPolicy: 'NEVER',
      heldTemplate: 'PAYMENT_RECOVERED',
      resolveExistingOnly: true,
      stripeCustomerId: seeded.stripeCustomerId,
      stripeSubscriptionId: seeded.stripeSubscriptionId
    });
    const failed = operationalEvent({
      eventId: `evt_${randomUUID()}`,
      eventCreatedAt: new Date('2026-11-12T00:39:00.000Z'),
      providerObjectId: invoiceId,
      stripeCustomerId: seeded.stripeCustomerId,
      stripeSubscriptionId: seeded.stripeSubscriptionId
    });

    await expect(repository().applyOperationalEvent(paid)).resolves.toBe(
      'APPLIED'
    );
    await expect(repository().applyOperationalEvent(failed)).resolves.toBe(
      'IGNORED_OUT_OF_ORDER'
    );

    const cases = await client.db
      .select()
      .from(billingCases)
      .where(eq(billingCases.providerObjectId, invoiceId));
    const notices = await client.db
      .select()
      .from(transactionalEmailOutbox)
      .where(eq(transactionalEmailOutbox.organisationId, seeded.organisationId));
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    const events = await client.db
      .select()
      .from(subscriptionEvents)
      .where(
        and(
          eq(subscriptionEvents.organisationId, seeded.organisationId),
          eq(subscriptionEvents.providerObjectId, invoiceId)
        )
      );

    expect(cases).toEqual([]);
    expect(notices).toEqual([]);
    expect(organisation?.platformStatus).toBe('ACTIVE');
    expect(events.map((event) => event.outcome).sort()).toEqual([
      'APPLIED',
      'IGNORED_OUT_OF_ORDER'
    ]);
  });
});
