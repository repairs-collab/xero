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
    await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });

    const mandateInput = {
      organisationId: seeded.organisationId,
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
        activatedByUserId: seeded.userId,
        activatedAt: now,
        stripePaymentMethodId: mandateInput.stripePaymentMethodId,
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).rejects.toThrow('DIRECT_DEBIT_MANDATE_REQUIRED');

    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      actorUserId: seeded.userId,
      setupSessionId: `cs_setup_${seeded.organisationId}`,
      occurredAt: now
    });
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
        activatedByUserId: seeded.userId,
        activatedAt: new Date('2026-11-09T12:30:00.000Z'),
        stripePaymentMethodId: 'pm_wrong',
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).rejects.toThrow('DIRECT_DEBIT_MANDATE_REQUIRED');
    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
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
});
