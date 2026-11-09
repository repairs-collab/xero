import { and, eq, isNull, or } from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  type DbTransaction,
  organisations,
  subscriptionEvents,
  subscriptions,
  users
} from '@bc5000/db/web';

import {
  decideStripeEventApplication,
  type BillingAccount,
  type StripeCheckoutCompletedInput,
  type StripeEventApplicationOutcome,
  type StripeLifecycleEventInput,
  type SubscriptionRepository
} from './subscription-service.js';

const postgresErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === 'string') return value.code;
  return postgresErrorCode(value.cause);
};

const eventOutcome = (
  value: StripeEventApplicationOutcome
): 'APPLIED' | 'IGNORED_OUT_OF_ORDER' | 'REJECTED' => {
  if (value === 'DUPLICATE') {
    throw new Error('Duplicate events are never inserted twice');
  }
  return value;
};

const insertEvent = async (
  transaction: DbTransaction,
  input: {
    organisationId: string;
    eventId: string;
    eventType: string;
    eventCreatedAt: Date;
    payloadHash: string;
  },
  outcome: Exclude<StripeEventApplicationOutcome, 'DUPLICATE'>
): Promise<void> => {
  await transaction.insert(subscriptionEvents).values({
    organisationId: input.organisationId,
    stripeEventId: input.eventId,
    eventType: input.eventType,
    stripeEventCreatedAt: input.eventCreatedAt,
    payloadHash: input.payloadHash,
    outcome: eventOutcome(outcome)
  });
};

const unsafeForSending = new Set([
  'PAST_DUE',
  'CANCEL_AT_PERIOD_END',
  'CANCELLED',
  'INCOMPLETE'
]);

export const createPostgresSubscriptionRepository = (
  database: Database,
  clock: { now(): Date }
): SubscriptionRepository => {
  const loadBillingAccount = async (
    organisationId: string,
    userId: string
  ): Promise<BillingAccount | null> => {
    const [row] = await database
      .select({
        organisationId: organisations.id,
        billingEmail: users.email,
        edition: organisations.edition,
        planCode: subscriptions.planCode,
        status: subscriptions.status,
        stripeCustomerId: subscriptions.stripeCustomerId,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        trialEndsAt: subscriptions.trialEndsAt,
        cancelAt: subscriptions.cancelAt,
        cancelledAt: subscriptions.cancelledAt,
        lastStripeEventCreatedAt: subscriptions.lastStripeEventCreatedAt,
        createdAt: subscriptions.createdAt
      })
      .from(organisations)
      .innerJoin(
        subscriptions,
        eq(subscriptions.organisationId, organisations.id)
      )
      .innerJoin(users, eq(users.id, userId))
      .where(
        and(
          eq(organisations.id, organisationId),
          isNull(users.disabledAt)
        )
      )
      .limit(1);
    return row ?? null;
  };

  const eventExists = async (eventId: string): Promise<boolean> => {
    const [row] = await database
      .select({ id: subscriptionEvents.id })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, eventId))
      .limit(1);
    return row !== undefined;
  };

  const applyCheckoutCompleted = async (
    input: StripeCheckoutCompletedInput
  ): Promise<StripeEventApplicationOutcome> => {
    try {
      return await database.transaction(async (transaction) => {
        const [duplicate] = await transaction
          .select({ id: subscriptionEvents.id })
          .from(subscriptionEvents)
          .where(eq(subscriptionEvents.stripeEventId, input.eventId))
          .limit(1);
        if (duplicate !== undefined) return 'DUPLICATE';

        const [organisation] = await transaction
          .select({ edition: organisations.edition })
          .from(organisations)
          .where(eq(organisations.id, input.organisationId))
          .for('update')
          .limit(1);
        const [subscription] = await transaction
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, input.organisationId))
          .for('update')
          .limit(1);
        if (organisation === undefined || subscription === undefined) {
          throw new Error('SUBSCRIPTION_NOT_FOUND');
        }
        if (organisation.edition !== 'SOLO') {
          await insertEvent(transaction, input, 'REJECTED');
          return 'REJECTED';
        }

        const decision = decideStripeEventApplication({
          eventAlreadyProcessed: false,
          eventCreatedAt: input.eventCreatedAt,
          lastAppliedAt: null,
          existingCustomerId: subscription.stripeCustomerId,
          incomingCustomerId: input.stripeCustomerId,
          existingSubscriptionId: subscription.stripeSubscriptionId,
          incomingSubscriptionId: input.stripeSubscriptionId
        });
        if (decision !== 'APPLIED') {
          await insertEvent(transaction, input, eventOutcome(decision));
          return decision;
        }

        const [ownedElsewhere] = await transaction
          .select({ organisationId: subscriptions.organisationId })
          .from(subscriptions)
          .where(
            or(
              eq(subscriptions.stripeCustomerId, input.stripeCustomerId),
              eq(
                subscriptions.stripeSubscriptionId,
                input.stripeSubscriptionId
              )
            )
          )
          .limit(1);
        if (
          ownedElsewhere !== undefined &&
          ownedElsewhere.organisationId !== input.organisationId
        ) {
          await insertEvent(transaction, input, 'REJECTED');
          return 'REJECTED';
        }

        await transaction
          .update(subscriptions)
          .set({
            stripeCustomerId: input.stripeCustomerId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            updatedAt: clock.now()
          })
          .where(eq(subscriptions.organisationId, input.organisationId));
        await insertEvent(transaction, input, 'APPLIED');
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          eventType: 'STRIPE_CHECKOUT_COMPLETED',
          entityType: 'SUBSCRIPTION',
          entityId: input.organisationId,
          afterValue: { planCode: 'SOLO_AU_2000' },
          occurredAt: clock.now()
        });
        return 'APPLIED';
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505' && (await eventExists(input.eventId))) {
        return 'DUPLICATE';
      }
      throw error;
    }
  };

  const applyLifecycleEvent = async (
    input: StripeLifecycleEventInput
  ): Promise<StripeEventApplicationOutcome> => {
    try {
      return await database.transaction(async (transaction) => {
        const [duplicate] = await transaction
          .select({ id: subscriptionEvents.id })
          .from(subscriptionEvents)
          .where(eq(subscriptionEvents.stripeEventId, input.eventId))
          .limit(1);
        if (duplicate !== undefined) return 'DUPLICATE';

        const [organisation] = await transaction
          .select({ edition: organisations.edition })
          .from(organisations)
          .where(eq(organisations.id, input.organisationId))
          .for('update')
          .limit(1);
        const [subscription] = await transaction
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, input.organisationId))
          .for('update')
          .limit(1);
        if (organisation === undefined || subscription === undefined) {
          throw new Error('SUBSCRIPTION_NOT_FOUND');
        }
        if (organisation.edition !== 'SOLO') {
          await insertEvent(transaction, input, 'REJECTED');
          return 'REJECTED';
        }

        const [ownedElsewhere] = await transaction
          .select({ organisationId: subscriptions.organisationId })
          .from(subscriptions)
          .where(
            or(
              eq(subscriptions.stripeCustomerId, input.stripeCustomerId),
              eq(
                subscriptions.stripeSubscriptionId,
                input.stripeSubscriptionId
              )
            )
          )
          .limit(1);
        const ownershipMismatch =
          ownedElsewhere !== undefined &&
          ownedElsewhere.organisationId !== input.organisationId;
        const decision = ownershipMismatch
          ? 'REJECTED'
          : decideStripeEventApplication({
              eventAlreadyProcessed: false,
              eventCreatedAt: input.eventCreatedAt,
              lastAppliedAt: subscription.lastStripeEventCreatedAt,
              existingCustomerId: subscription.stripeCustomerId,
              incomingCustomerId: input.stripeCustomerId,
              existingSubscriptionId: subscription.stripeSubscriptionId,
              incomingSubscriptionId: input.stripeSubscriptionId
            });
        if (decision !== 'APPLIED') {
          await insertEvent(transaction, input, eventOutcome(decision));
          return decision;
        }

        const now = clock.now();
        await transaction
          .update(subscriptions)
          .set({
            status: input.status,
            stripeCustomerId: input.stripeCustomerId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            currentPeriodStart: input.currentPeriodStart,
            currentPeriodEnd: input.currentPeriodEnd,
            trialEndsAt: input.trialEndsAt,
            cancelAt: input.cancelAt,
            cancelledAt: input.cancelledAt,
            lastStripeEventCreatedAt: input.eventCreatedAt,
            updatedAt: now
          })
          .where(eq(subscriptions.organisationId, input.organisationId));
        if (unsafeForSending.has(input.status)) {
          await transaction
            .update(organisations)
            .set({
              sendMode: 'dry-run',
              rolloutScope: 'CONTROLLED',
              liveSendAcknowledged: false,
              updatedAt: now
            })
            .where(eq(organisations.id, input.organisationId));
        }
        await insertEvent(transaction, input, 'APPLIED');
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          eventType: 'SUBSCRIPTION_STATUS_APPLIED',
          entityType: 'SUBSCRIPTION',
          entityId: input.organisationId,
          afterValue: {
            planCode: input.planCode,
            status: input.status,
            currentPeriodEnd: input.currentPeriodEnd.toISOString(),
            cancelAt: input.cancelAt?.toISOString() ?? null
          },
          occurredAt: now
        });
        return 'APPLIED';
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505' && (await eventExists(input.eventId))) {
        return 'DUPLICATE';
      }
      throw error;
    }
  };

  const recordBillingAudit: SubscriptionRepository['recordBillingAudit'] =
    async (input) => {
      await database.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: input.actorUserId,
        eventType: input.detail.action,
        entityType: 'SUBSCRIPTION',
        entityId: input.organisationId,
        afterValue: input.detail,
        occurredAt: input.occurredAt
      });
    };

  const recordRejectedEvent: SubscriptionRepository['recordRejectedEvent'] =
    async (input) => {
      try {
        return await database.transaction(async (transaction) => {
          const [duplicate] = await transaction
            .select({ id: subscriptionEvents.id })
            .from(subscriptionEvents)
            .where(eq(subscriptionEvents.stripeEventId, input.eventId))
            .limit(1);
          if (duplicate !== undefined) return 'DUPLICATE';
          const [organisation] = await transaction
            .select({ id: organisations.id })
            .from(organisations)
            .where(eq(organisations.id, input.organisationId))
            .limit(1);
          if (organisation === undefined) {
            throw new Error('SUBSCRIPTION_NOT_FOUND');
          }
          await insertEvent(transaction, input, 'REJECTED');
          return 'REJECTED';
        });
      } catch (error) {
        if (
          postgresErrorCode(error) === '23505' &&
          (await eventExists(input.eventId))
        ) {
          return 'DUPLICATE';
        }
        throw error;
      }
    };

  return {
    loadBillingAccount,
    applyLifecycleEvent,
    applyCheckoutCompleted,
    recordRejectedEvent,
    recordBillingAudit
  };
};
