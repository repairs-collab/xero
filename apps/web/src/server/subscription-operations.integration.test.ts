import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
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

const repository = () =>
  createPostgresSubscriptionRepository(client.db, { now: () => clockNow });

describe('operational Stripe event persistence', () => {
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
});
