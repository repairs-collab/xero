import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  directDebitRequests,
  memberships,
  migrateDatabase,
  organisations,
  subscriptions,
  users
} from '@bc5000/db';

import { createPostgresSubscriptionRepository } from '../src/server/subscription-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-09T12:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const seed = async (withInitialCardEvidence = false) => {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const stripeCustomerId = `cus_${organisationId}`;
  const stripeSubscriptionId = `sub_${organisationId}`;
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Direct debit integration test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO'
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Billing administrator'
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
    stripeProviderStatus: 'active',
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodStart: new Date('2026-11-09T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-12-09T00:00:00.000Z'),
    ...(withInitialCardEvidence
      ? {
          initialCardStripeSubscriptionId: stripeSubscriptionId,
          initialCardInvoiceId: `in_${organisationId}`,
          initialCardPaymentSucceededAt: new Date(
            '2026-11-09T10:00:00.000Z'
          )
        }
      : {})
  });
  return {
    organisationId,
    userId,
    stripeCustomerId,
    stripeSubscriptionId
  };
};

describe('request-only direct debit persistence', () => {
  it('requires a positive paid card Checkout before allowing an idempotent request', async () => {
    const seeded = await seed();
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });

    await expect(
      repository.requestDirectDebit({
        organisationId: seeded.organisationId,
        requestedByUserId: seeded.userId,
        requestedAt: now
      })
    ).rejects.toThrow('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');

    await expect(
      repository.applyOperationalEvent({
        eventId: `evt_paid_invoice_only_${seeded.organisationId}`,
        eventType: 'invoice.paid',
        eventCreatedAt: new Date('2026-11-09T11:00:00.000Z'),
        payloadHash: 'a'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        providerObjectType: 'INVOICE',
        providerObjectId: `in_out_of_band_${seeded.organisationId}`,
        providerStatus: 'paid',
        amountMinor: 0,
        currency: 'aud',
        caseKind: 'PAYMENT_FAILURE',
        targetStatus: 'RESOLVED',
        suspensionPolicy: 'NEVER',
        heldTemplate: 'PAYMENT_RECOVERED',
        resolveExistingOnly: true
      })
    ).resolves.toBe('APPLIED');

    const [afterInvoiceOnly] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, seeded.organisationId));
    expect(afterInvoiceOnly?.initialCardInvoiceId).toBeNull();
    await expect(
      repository.requestDirectDebit({
        organisationId: seeded.organisationId,
        requestedByUserId: seeded.userId,
        requestedAt: now
      })
    ).rejects.toThrow('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');

    await expect(
      repository.applyCheckoutCompleted({
        organisationId: seeded.organisationId,
        eventId: `evt_initial_card_checkout_${seeded.organisationId}`,
        eventType: 'checkout.session.completed',
        eventCreatedAt: new Date('2026-11-09T11:05:00.000Z'),
        payloadHash: 'c'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        initialCardInvoiceId: `in_initial_${seeded.organisationId}`,
        initialCardPaymentSucceededAt: new Date(
          '2026-11-09T11:05:00.000Z'
        )
      })
    ).resolves.toBe('APPLIED');

    const [subscription] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, seeded.organisationId));
    expect(subscription).toMatchObject({
      initialCardInvoiceId: `in_initial_${seeded.organisationId}`,
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:05:00.000Z')
    });

    const input = {
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    };
    await expect(repository.requestDirectDebit(input)).resolves.toMatchObject({
      status: 'REQUESTED'
    });
    await expect(repository.requestDirectDebit(input)).resolves.toMatchObject({
      status: 'REQUESTED',
      requestedAt: now
    });
  });

  it('requires setup before signed mandate evidence and exact evidence before activation', async () => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    const request = await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });

    const mandateInput = {
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_mandate_${seeded.organisationId}`,
      eventType: 'setup_intent.succeeded' as const,
      eventCreatedAt: new Date('2026-11-09T12:15:00.000Z'),
      payloadHash: 'b'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupIntentId: `seti_${seeded.organisationId}`,
      stripePaymentMethodId: `pm_${seeded.organisationId}`,
      stripeMandateId: `mandate_${seeded.organisationId}`
    };
    await expect(
      repository.confirmDirectDebitMandate(mandateInput)
    ).resolves.toBe('REJECTED');
    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        activatedByUserId: seeded.userId,
        activatedAt: now,
        stripePaymentMethodId: mandateInput.stripePaymentMethodId,
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).rejects.toThrow('DIRECT_DEBIT_MANDATE_REQUIRED');

    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 1,
      setupSessionId: `cs_setup_${seeded.organisationId}`,
      setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
      occurredAt: now
    });
    await expect(
      repository.bindDirectDebitSetupCheckout({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        setupAttemptVersion: 1,
        eventId: `evt_setup_checkout_${seeded.organisationId}`,
        eventType: 'checkout.session.completed',
        eventCreatedAt: new Date('2026-11-09T12:10:00.000Z'),
        payloadHash: 'd'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        setupSessionId: `cs_setup_${seeded.organisationId}`,
        setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
        setupIntentId: mandateInput.setupIntentId
      })
    ).resolves.toBe('APPLIED');
    await expect(
      repository.confirmDirectDebitMandate({
        ...mandateInput,
        eventId: `evt_mandate_applied_${seeded.organisationId}`
      })
    ).resolves.toBe('APPLIED');
    await expect(
      repository.confirmDirectDebitMandate({
        ...mandateInput,
        eventId: `evt_mandate_applied_${seeded.organisationId}`
      })
    ).resolves.toBe('DUPLICATE');

    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        activatedByUserId: seeded.userId,
        activatedAt: new Date('2026-11-09T12:30:00.000Z'),
        stripePaymentMethodId: 'pm_wrong',
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).rejects.toThrow('DIRECT_DEBIT_MANDATE_REQUIRED');
    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        activatedByUserId: seeded.userId,
        activatedAt: new Date('2026-11-09T12:30:00.000Z'),
        stripePaymentMethodId: mandateInput.stripePaymentMethodId,
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).resolves.toMatchObject({ status: 'ACTIVE' });

    const [stored] = await client.db
      .select()
      .from(directDebitRequests)
      .where(eq(directDebitRequests.organisationId, seeded.organisationId));
    expect(stored).toMatchObject({
      status: 'ACTIVE',
      setupSessionId: `cs_setup_${seeded.organisationId}`,
      setupIntentId: mandateInput.setupIntentId,
      stripePaymentMethodId: mandateInput.stripePaymentMethodId,
      stripeMandateId: mandateInput.stripeMandateId
    });
  });

  it('versions an expired setup retry and rejects evidence from the abandoned link', async () => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => new Date('2026-11-09T13:00:00.000Z')
    });
    const request = await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });
    const firstExpiry = new Date('2026-11-09T12:30:00.000Z');
    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 1,
      setupSessionId: `cs_first_${seeded.organisationId}`,
      setupSessionExpiresAt: firstExpiry,
      occurredAt: now
    });
    await repository.bindDirectDebitSetupCheckout({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_first_setup_${seeded.organisationId}`,
      eventType: 'checkout.session.completed',
      eventCreatedAt: new Date('2026-11-09T12:10:00.000Z'),
      payloadHash: '1'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupSessionId: `cs_first_${seeded.organisationId}`,
      setupSessionExpiresAt: firstExpiry,
      setupIntentId: `seti_first_${seeded.organisationId}`
    });

    const secondExpiry = new Date('2026-11-10T13:00:00.000Z');
    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 2,
      setupSessionId: `cs_second_${seeded.organisationId}`,
      setupSessionExpiresAt: secondExpiry,
      occurredAt: new Date('2026-11-09T13:00:00.000Z')
    });

    await expect(
      repository.bindDirectDebitSetupCheckout({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        setupAttemptVersion: 1,
        eventId: `evt_late_first_setup_${seeded.organisationId}`,
        eventType: 'checkout.session.completed',
        eventCreatedAt: new Date('2026-11-09T13:05:00.000Z'),
        payloadHash: '2'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        setupSessionId: `cs_first_${seeded.organisationId}`,
        setupSessionExpiresAt: firstExpiry,
        setupIntentId: `seti_first_${seeded.organisationId}`
      })
    ).resolves.toBe('REJECTED');

    const current = await repository.loadDirectDebitRequest(
      seeded.organisationId
    );
    expect(current).toMatchObject({
      setupAttemptVersion: 2,
      setupSessionId: `cs_second_${seeded.organisationId}`,
      setupSessionExpiresAt: secondExpiry,
      setupCheckoutCompletedAt: null,
      setupIntentId: null
    });
  });

  it('preserves an old active mandate but requires a fresh request for a replacement subscription', async () => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    const request = await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });
    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 1,
      setupSessionId: `cs_old_${seeded.organisationId}`,
      setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
      occurredAt: now
    });
    const mandate = {
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_old_mandate_${seeded.organisationId}`,
      eventType: 'setup_intent.succeeded' as const,
      eventCreatedAt: new Date('2026-11-09T12:05:00.000Z'),
      payloadHash: 'e'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupIntentId: `seti_old_${seeded.organisationId}`,
      stripePaymentMethodId: `pm_old_${seeded.organisationId}`,
      stripeMandateId: `mandate_old_${seeded.organisationId}`
    };
    await repository.bindDirectDebitSetupCheckout({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_old_setup_checkout_${seeded.organisationId}`,
      eventType: 'checkout.session.completed',
      eventCreatedAt: new Date('2026-11-09T12:02:00.000Z'),
      payloadHash: 'f'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupSessionId: `cs_old_${seeded.organisationId}`,
      setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
      setupIntentId: mandate.setupIntentId
    });
    await expect(
      repository.confirmDirectDebitMandate(mandate)
    ).resolves.toBe('APPLIED');
    await repository.activateDirectDebit({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      activatedByUserId: seeded.userId,
      activatedAt: new Date('2026-11-09T12:10:00.000Z'),
      stripePaymentMethodId: mandate.stripePaymentMethodId,
      stripeMandateId: mandate.stripeMandateId
    });

    const replacementSubscriptionId = `sub_replacement_${seeded.organisationId}`;
    await client.db
      .update(subscriptions)
      .set({
        stripeSubscriptionId: replacementSubscriptionId,
        initialCardStripeSubscriptionId: replacementSubscriptionId,
        initialCardInvoiceId: `in_replacement_${seeded.organisationId}`,
        initialCardPaymentSucceededAt: new Date('2026-11-10T09:00:00.000Z')
      })
      .where(eq(subscriptions.organisationId, seeded.organisationId));

    await expect(
      repository.loadDirectDebitRequest(seeded.organisationId)
    ).resolves.toBeNull();
    await expect(
      repository.requestDirectDebit({
        organisationId: seeded.organisationId,
        requestedByUserId: seeded.userId,
        requestedAt: new Date('2026-11-10T09:05:00.000Z')
      })
    ).resolves.toMatchObject({ status: 'REQUESTED' });

    const history = await client.db
      .select()
      .from(directDebitRequests)
      .where(eq(directDebitRequests.organisationId, seeded.organisationId));
    expect(history).toHaveLength(2);
    expect(history.map((request) => request.status).sort()).toEqual([
      'ACTIVE',
      'REQUESTED'
    ]);
  });

  it.each([
    ['disabled', { disabledAt: now }],
    ['no longer an Admin', { role: 'OPERATOR' as const }]
  ])('withholds setup delivery when the requester is %s', async (_label, update) => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });
    await client.db
      .update(memberships)
      .set(update)
      .where(
        eq(memberships.organisationId, seeded.organisationId)
      );

    await expect(
      repository.loadDirectDebitRequesterEmail(seeded.organisationId)
    ).resolves.toBeNull();
  });
});
