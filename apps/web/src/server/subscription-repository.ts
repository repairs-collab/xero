import { createHash } from 'node:crypto';

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

import {
  auditEvents,
  billingCases,
  directDebitRequests,
  type Database,
  type DbTransaction,
  memberships,
  organisations,
  retiredStripeSubscriptions,
  subscriptionEvents,
  subscriptions,
  transactionalEmailOutbox,
  users
} from '@bc5000/db/web';

import {
  decideStripeEventApplication,
  retainedTrialEnd,
  shouldRetireIgnoredReplacementCandidate,
  type BillingAccount,
  type DirectDebitRequestRecord,
  type StripeCheckoutCompletedInput,
  type StripeEventApplicationOutcome,
  type StripeEventReplayResult,
  type StripeLifecycleEventInput,
  type StripeOperationalEventInput,
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
    providerObjectType?: StripeOperationalEventInput['providerObjectType'];
    providerObjectId?: string;
    billingCaseKind?: StripeOperationalEventInput['caseKind'];
    billingCaseStatus?: StripeOperationalEventInput['targetStatus'];
    blocksSending?: boolean;
    amountMinor?: number;
    heldTemplate?: StripeOperationalEventInput['heldTemplate'];
  },
  outcome: Exclude<StripeEventApplicationOutcome, 'DUPLICATE'>
): Promise<void> => {
  await transaction.insert(subscriptionEvents).values({
    organisationId: input.organisationId,
    stripeEventId: input.eventId,
    eventType: input.eventType,
    stripeEventCreatedAt: input.eventCreatedAt,
    payloadHash: input.payloadHash,
    providerObjectType: input.providerObjectType,
    providerObjectId: input.providerObjectId,
    billingCaseKind: input.billingCaseKind,
    billingCaseStatus: input.billingCaseStatus,
    blocksSending: input.blocksSending,
    amountMinor: input.amountMinor,
    heldTemplate: input.heldTemplate,
    outcome: eventOutcome(outcome)
  });
};

const operationalEventEvidence = (
  input: StripeOperationalEventInput,
  organisationId: string,
  blocksSending: boolean
) => ({
  ...input,
  organisationId,
  billingCaseKind: input.caseKind,
  billingCaseStatus: input.targetStatus,
  blocksSending
});

const latestAppliedCheckoutAt = async (
  transaction: DbTransaction,
  organisationId: string
): Promise<Date | null> => {
  const [latestCheckout] = await transaction
    .select({ createdAt: subscriptionEvents.stripeEventCreatedAt })
    .from(subscriptionEvents)
    .where(
      and(
        eq(subscriptionEvents.organisationId, organisationId),
        eq(subscriptionEvents.eventType, 'checkout.session.completed'),
        eq(subscriptionEvents.outcome, 'APPLIED')
      )
    )
    .orderBy(desc(subscriptionEvents.stripeEventCreatedAt))
    .limit(1);
  return latestCheckout?.createdAt ?? null;
};

const unsafeForSending = new Set([
  'PAST_DUE',
  'CANCELLED',
  'INCOMPLETE'
]);

const operationalEventBlocksSending = (
  input: StripeOperationalEventInput,
  relation: 'CURRENT' | 'RETIRED'
): boolean =>
  input.suspensionPolicy === 'ALWAYS' ||
  (input.suspensionPolicy === 'CURRENT_ONLY' && relation === 'CURRENT');

const operationalRiskRank = (input: {
  status: 'OPEN' | 'RESOLVED' | 'REVIEW_REQUIRED';
  blocksSending: boolean;
}): number => {
  if (input.blocksSending && input.status === 'OPEN') return 5;
  if (input.blocksSending && input.status === 'REVIEW_REQUIRED') return 4;
  if (input.status === 'OPEN') return 3;
  if (input.status === 'REVIEW_REQUIRED') return 2;
  return 1;
};

const persistedOperationalRiskRank = sql<number>`case
  when ${subscriptionEvents.blocksSending} = true and ${subscriptionEvents.billingCaseStatus} = 'OPEN' then 5
  when ${subscriptionEvents.blocksSending} = true and ${subscriptionEvents.billingCaseStatus} = 'REVIEW_REQUIRED' then 4
  when ${subscriptionEvents.billingCaseStatus} = 'OPEN' then 3
  when ${subscriptionEvents.billingCaseStatus} = 'REVIEW_REQUIRED' then 2
  else 1
end`;

const normalizedEmail = (value: string): string =>
  value.trim().toLocaleLowerCase('en-AU');

const validNoticeRecipient = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 320 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const noticeIdempotencyKey = (
  eventId: string,
  template: StripeOperationalEventInput['heldTemplate'],
  recipient: string
): string =>
  `stripe:${eventId}:${template}:v1:${createHash('sha256').update(recipient).digest('hex')}`;

const lockStripeSubscriptionOwnership = async (
  transaction: DbTransaction,
  subscriptionIds: Array<string | null>
): Promise<void> => {
  const orderedIds = [...new Set(subscriptionIds.filter((id): id is string => id !== null))]
    .sort();
  for (const subscriptionId of orderedIds) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${subscriptionId}, 0::bigint))`
    );
  }
};

const toDirectDebitRequestRecord = (
  row: typeof directDebitRequests.$inferSelect
): DirectDebitRequestRecord => {
  if (row.stripeSubscriptionId === null || row.status === 'LEGACY_UNBOUND') {
    throw new Error('DIRECT_DEBIT_REQUEST_NOT_CURRENT');
  }
  return {
    id: row.id,
    organisationId: row.organisationId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    status: row.status,
    requestedAt: row.requestedAt,
    setupAttemptVersion: row.setupAttemptVersion,
    setupSessionId: row.setupSessionId,
    setupSessionExpiresAt: row.setupSessionExpiresAt,
    setupCheckoutCompletedAt: row.setupCheckoutCompletedAt,
    setupIntentId: row.setupIntentId,
    stripePaymentMethodId: row.stripePaymentMethodId,
    stripeMandateId: row.stripeMandateId,
    mandateConfirmedAt: row.mandateConfirmedAt,
    activatedAt: row.activatedAt
  };
};

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
        billingCadence: subscriptions.billingCadence,
        status: subscriptions.status,
        stripeProviderStatus: subscriptions.trustedStripeProviderStatus,
        stripeCustomerId: subscriptions.stripeCustomerId,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        trialEndsAt: subscriptions.trialEndsAt,
        cancelAt: subscriptions.cancelAt,
        cancelledAt: subscriptions.cancelledAt,
        lastStripeEventCreatedAt: subscriptions.lastStripeEventCreatedAt,
        initialCardInvoiceId: subscriptions.initialCardInvoiceId,
        initialCardStripeSubscriptionId:
          subscriptions.initialCardStripeSubscriptionId,
        initialCardPaymentSucceededAt:
          subscriptions.initialCardPaymentSucceededAt,
        directDebitStatus: directDebitRequests.status,
        createdAt: subscriptions.createdAt
      })
      .from(organisations)
      .innerJoin(
        subscriptions,
        eq(subscriptions.organisationId, organisations.id)
      )
      .innerJoin(users, eq(users.id, userId))
      .leftJoin(
        directDebitRequests,
        and(
          eq(directDebitRequests.organisationId, organisations.id),
          eq(
            directDebitRequests.stripeSubscriptionId,
            subscriptions.stripeSubscriptionId
          )
        )
      )
      .where(
        and(
          eq(organisations.id, organisationId),
          isNull(users.disabledAt)
        )
      )
      .limit(1);
    if (row === undefined) return null;
    const directDebitStatus =
      row.directDebitStatus === 'LEGACY_UNBOUND' ? null : row.directDebitStatus;
    return { ...row, directDebitStatus };
  };

  const lookupEventReplay: SubscriptionRepository['lookupEventReplay'] = async (
    input
  ): Promise<StripeEventReplayResult> => {
    const [row] = await database
      .select({ payloadHash: subscriptionEvents.payloadHash })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.stripeEventId, input.eventId))
      .limit(1);
    if (row === undefined) return 'ABSENT';
    return row.payloadHash === input.payloadHash
      ? 'DUPLICATE'
      : 'HASH_MISMATCH';
  };

  const applyCheckoutCompleted = async (
    input: StripeCheckoutCompletedInput
  ): Promise<StripeEventApplicationOutcome> => {
    try {
      return await database.transaction(async (transaction) => {
        const [duplicate] = await transaction
          .select({ payloadHash: subscriptionEvents.payloadHash })
          .from(subscriptionEvents)
          .where(eq(subscriptionEvents.stripeEventId, input.eventId))
          .limit(1);
        if (duplicate !== undefined) {
          if (duplicate.payloadHash !== input.payloadHash) {
            throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
          }
          return 'DUPLICATE';
        }

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

        await lockStripeSubscriptionOwnership(transaction, [
          input.stripeSubscriptionId,
          subscription.stripeSubscriptionId
        ]);

        const [retired] = await transaction.select({ id: retiredStripeSubscriptions.stripeSubscriptionId })
          .from(retiredStripeSubscriptions)
          .where(eq(retiredStripeSubscriptions.stripeSubscriptionId, input.stripeSubscriptionId)).limit(1);
        const latestCheckoutAt = await latestAppliedCheckoutAt(
          transaction,
          input.organisationId
        );
        const decision = decideStripeEventApplication({
          eventAlreadyProcessed: false,
          eventCreatedAt: input.eventCreatedAt,
          lastAppliedAt: subscription.stripeSubscriptionId !== input.stripeSubscriptionId ? subscription.lastStripeEventCreatedAt : null,
          lastAppliedCheckoutAt: latestCheckoutAt,
          existingCustomerId: subscription.stripeCustomerId,
          incomingCustomerId: input.stripeCustomerId,
          existingSubscriptionId: subscription.stripeSubscriptionId,
          incomingSubscriptionId: input.stripeSubscriptionId,
          existingStatus: subscription.status,
          allowReplacement: true,
          isRetired: retired !== undefined
        });
        if (decision !== 'APPLIED') {
          if (
            shouldRetireIgnoredReplacementCandidate({
              outcome: decision,
              existingStatus: subscription.status,
              existingCustomerId: subscription.stripeCustomerId,
              incomingCustomerId: input.stripeCustomerId,
              existingSubscriptionId: subscription.stripeSubscriptionId,
              incomingSubscriptionId: input.stripeSubscriptionId
            })
          ) {
            await transaction
              .insert(retiredStripeSubscriptions)
              .values({
                stripeSubscriptionId: input.stripeSubscriptionId,
                organisationId: input.organisationId
              })
              .onConflictDoNothing();
          }
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

        if (subscription.stripeSubscriptionId !== null && subscription.stripeSubscriptionId !== input.stripeSubscriptionId) {
          await transaction.insert(retiredStripeSubscriptions).values({ stripeSubscriptionId: subscription.stripeSubscriptionId, organisationId: input.organisationId });
        }
        const sameBillingEpisode =
          subscription.initialCardStripeSubscriptionId ===
          input.stripeSubscriptionId;
        await transaction
          .update(subscriptions)
          .set({
            stripeCustomerId: input.stripeCustomerId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            initialCardStripeSubscriptionId: input.stripeSubscriptionId,
            initialCardInvoiceId:
              sameBillingEpisode
                ? (subscription.initialCardInvoiceId ??
                  input.initialCardInvoiceId)
                : input.initialCardInvoiceId,
            initialCardPaymentSucceededAt:
              sameBillingEpisode
                ? (subscription.initialCardPaymentSucceededAt ??
                  input.initialCardPaymentSucceededAt)
                : input.initialCardPaymentSucceededAt,
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
      if (postgresErrorCode(error) === '23505') {
        const replay = await lookupEventReplay({
          eventId: input.eventId,
          payloadHash: input.payloadHash
        });
        if (replay === 'DUPLICATE') return 'DUPLICATE';
        if (replay === 'HASH_MISMATCH') {
          throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
        }
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
          .select({ payloadHash: subscriptionEvents.payloadHash })
          .from(subscriptionEvents)
          .where(eq(subscriptionEvents.stripeEventId, input.eventId))
          .limit(1);
        if (duplicate !== undefined) {
          if (duplicate.payloadHash !== input.payloadHash) {
            throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
          }
          return 'DUPLICATE';
        }

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

        await lockStripeSubscriptionOwnership(transaction, [
          input.stripeSubscriptionId,
          subscription.stripeSubscriptionId
        ]);

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
        const [retired] = await transaction.select({ id: retiredStripeSubscriptions.stripeSubscriptionId })
          .from(retiredStripeSubscriptions)
          .where(eq(retiredStripeSubscriptions.stripeSubscriptionId, input.stripeSubscriptionId)).limit(1);
        const latestCheckoutAt = await latestAppliedCheckoutAt(
          transaction,
          input.organisationId
        );
        const ownershipMismatch =
          ownedElsewhere !== undefined &&
          ownedElsewhere.organisationId !== input.organisationId;
        const decision = ownershipMismatch
          ? 'REJECTED'
          : decideStripeEventApplication({
              eventAlreadyProcessed: false,
              eventCreatedAt: input.eventCreatedAt,
              lastAppliedAt: subscription.lastStripeEventCreatedAt,
              lastAppliedCheckoutAt: latestCheckoutAt,
              existingCustomerId: subscription.stripeCustomerId,
              incomingCustomerId: input.stripeCustomerId,
              existingSubscriptionId: subscription.stripeSubscriptionId,
              incomingSubscriptionId: input.stripeSubscriptionId,
              existingStatus: subscription.status,
              incomingStatus: input.status,
              allowReplacement: true,
              isRetired: retired !== undefined
            });
        if (decision !== 'APPLIED') {
          if (
            shouldRetireIgnoredReplacementCandidate({
              outcome: decision,
              existingStatus: subscription.status,
              existingCustomerId: subscription.stripeCustomerId,
              incomingCustomerId: input.stripeCustomerId,
              existingSubscriptionId: subscription.stripeSubscriptionId,
              incomingSubscriptionId: input.stripeSubscriptionId
            })
          ) {
            await transaction
              .insert(retiredStripeSubscriptions)
              .values({
                stripeSubscriptionId: input.stripeSubscriptionId,
                organisationId: input.organisationId
              })
              .onConflictDoNothing();
          }
          await insertEvent(transaction, input, eventOutcome(decision));
          return decision;
        }

        if (subscription.stripeSubscriptionId !== null && subscription.stripeSubscriptionId !== input.stripeSubscriptionId) {
          await transaction.insert(retiredStripeSubscriptions).values({ stripeSubscriptionId: subscription.stripeSubscriptionId, organisationId: input.organisationId });
        }
        const now = clock.now();
        const replacesBillingEpisode =
          subscription.stripeSubscriptionId !== null &&
          subscription.stripeSubscriptionId !== input.stripeSubscriptionId;
        await transaction
          .update(subscriptions)
          .set({
            status: input.status,
            billingCadence: input.billingCadence,
            stripeProviderStatus: input.stripeProviderStatus,
            stripeCustomerId: input.stripeCustomerId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            currentPeriodStart: input.currentPeriodStart,
            currentPeriodEnd: input.currentPeriodEnd,
            trialEndsAt: retainedTrialEnd(subscription.trialEndsAt, input.trialEndsAt),
            cancelAt: input.cancelAt,
            cancelledAt: input.cancelledAt,
            lastStripeEventCreatedAt: input.eventCreatedAt,
            ...(replacesBillingEpisode
              ? {
                  initialCardStripeSubscriptionId: null,
                  initialCardInvoiceId: null,
                  initialCardPaymentSucceededAt: null
                }
              : {}),
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
            billingCadence: input.billingCadence,
            status: input.status,
            currentPeriodEnd: input.currentPeriodEnd.toISOString(),
            cancelAt: input.cancelAt?.toISOString() ?? null
          },
          occurredAt: now
        });
        return 'APPLIED';
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        const replay = await lookupEventReplay({
          eventId: input.eventId,
          payloadHash: input.payloadHash
        });
        if (replay === 'DUPLICATE') return 'DUPLICATE';
        if (replay === 'HASH_MISMATCH') {
          throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
        }
      }
      throw error;
    }
  };

  const applyOperationalEvent = async (
    input: StripeOperationalEventInput
  ): Promise<StripeEventApplicationOutcome> => {
    try {
      return await database.transaction(async (transaction) => {
        const [duplicate] = await transaction
          .select({ payloadHash: subscriptionEvents.payloadHash })
          .from(subscriptionEvents)
          .where(eq(subscriptionEvents.stripeEventId, input.eventId))
          .limit(1);
        if (duplicate !== undefined) {
          if (duplicate.payloadHash !== input.payloadHash) {
            throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
          }
          return 'DUPLICATE';
        }

        const [currentCandidate] = await transaction
          .select({
            organisationId: subscriptions.organisationId,
            stripeCustomerId: subscriptions.stripeCustomerId
          })
          .from(subscriptions)
          .where(
            eq(subscriptions.stripeSubscriptionId, input.stripeSubscriptionId)
          )
          .limit(1);
        const [retiredCandidate] = await transaction
          .select({
            organisationId: retiredStripeSubscriptions.organisationId,
            stripeCustomerId: subscriptions.stripeCustomerId
          })
          .from(retiredStripeSubscriptions)
          .innerJoin(
            subscriptions,
            eq(
              subscriptions.organisationId,
              retiredStripeSubscriptions.organisationId
            )
          )
          .where(
            eq(
              retiredStripeSubscriptions.stripeSubscriptionId,
              input.stripeSubscriptionId
            )
          )
          .limit(1);
        if (currentCandidate === undefined && retiredCandidate === undefined) {
          return 'REJECTED';
        }
        if (
          currentCandidate !== undefined &&
          retiredCandidate !== undefined &&
          (currentCandidate.organisationId !== retiredCandidate.organisationId ||
            currentCandidate.stripeCustomerId !==
              retiredCandidate.stripeCustomerId)
        ) {
          return 'REJECTED';
        }
        const candidate = currentCandidate ?? retiredCandidate!;
        if (candidate.stripeCustomerId !== input.stripeCustomerId) {
          return 'REJECTED';
        }

        const [organisation] = await transaction
          .select({
            id: organisations.id,
            edition: organisations.edition,
            platformStatus: organisations.platformStatus,
            platformStatusVersion: organisations.platformStatusVersion,
            suspendedAt: organisations.suspendedAt,
            suspensionReason: organisations.suspensionReason
          })
          .from(organisations)
          .where(eq(organisations.id, candidate.organisationId))
          .for('update')
          .limit(1);
        const [subscription] = await transaction
          .select({
            organisationId: subscriptions.organisationId,
            stripeCustomerId: subscriptions.stripeCustomerId,
            stripeSubscriptionId: subscriptions.stripeSubscriptionId
          })
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, candidate.organisationId))
          .for('update')
          .limit(1);
        if (
          organisation === undefined ||
          subscription === undefined ||
          organisation.edition !== 'SOLO' ||
          subscription.stripeCustomerId !== input.stripeCustomerId
        ) {
          return 'REJECTED';
        }
        await lockStripeSubscriptionOwnership(transaction, [
          input.stripeSubscriptionId
        ]);
        const [lockedCurrentOwner] = await transaction
          .select({
            organisationId: subscriptions.organisationId,
            stripeCustomerId: subscriptions.stripeCustomerId
          })
          .from(subscriptions)
          .where(
            eq(subscriptions.stripeSubscriptionId, input.stripeSubscriptionId)
          )
          .for('update')
          .limit(1);
        if (
          lockedCurrentOwner !== undefined &&
          (lockedCurrentOwner.organisationId !== organisation.id ||
            lockedCurrentOwner.stripeCustomerId !== input.stripeCustomerId)
        ) {
          return 'REJECTED';
        }
        const [retired] = await transaction
          .select({ organisationId: retiredStripeSubscriptions.organisationId })
          .from(retiredStripeSubscriptions)
          .where(
            eq(
              retiredStripeSubscriptions.stripeSubscriptionId,
              input.stripeSubscriptionId
            )
          )
          .for('update')
          .limit(1);
        if (
          retired !== undefined &&
          retired.organisationId !== organisation.id
        ) {
          return 'REJECTED';
        }
        const currentMatch = lockedCurrentOwner !== undefined;
        const retiredMatch = retired?.organisationId === organisation.id;
        if (currentMatch === retiredMatch) return 'REJECTED';
        const relation = currentMatch ? ('CURRENT' as const) : ('RETIRED' as const);

        const [existingCase] = await transaction
          .select()
          .from(billingCases)
          .where(
            and(
              eq(billingCases.organisationId, organisation.id),
              eq(billingCases.kind, input.caseKind),
              eq(billingCases.providerObjectType, input.providerObjectType),
              eq(billingCases.providerObjectId, input.providerObjectId)
            )
          )
          .for('update')
          .limit(1);
        const [finalCurrentOwner] = await transaction
          .select({
            organisationId: subscriptions.organisationId,
            stripeCustomerId: subscriptions.stripeCustomerId
          })
          .from(subscriptions)
          .where(
            eq(subscriptions.stripeSubscriptionId, input.stripeSubscriptionId)
          )
          .limit(1);
        const [finalRetiredOwner] = await transaction
          .select({ organisationId: retiredStripeSubscriptions.organisationId })
          .from(retiredStripeSubscriptions)
          .where(
            eq(
              retiredStripeSubscriptions.stripeSubscriptionId,
              input.stripeSubscriptionId
            )
          )
          .limit(1);
        if (
          (finalCurrentOwner !== undefined &&
            (finalCurrentOwner.organisationId !== organisation.id ||
              finalCurrentOwner.stripeCustomerId !== input.stripeCustomerId)) ||
          (finalRetiredOwner !== undefined &&
            finalRetiredOwner.organisationId !== organisation.id)
        ) {
          return 'REJECTED';
        }
        const finalCurrentMatch = finalCurrentOwner !== undefined;
        const finalRetiredMatch = finalRetiredOwner !== undefined;
        if (
          finalCurrentMatch === finalRetiredMatch ||
          (relation === 'CURRENT') !== finalCurrentMatch
        ) {
          return 'REJECTED';
        }
        const blocksSending = operationalEventBlocksSending(input, relation);
        const [latestAppliedEvidence] = await transaction
          .select({
            eventId: subscriptionEvents.stripeEventId,
            eventCreatedAt: subscriptionEvents.stripeEventCreatedAt,
            status: subscriptionEvents.billingCaseStatus,
            blocksSending: subscriptionEvents.blocksSending,
            amountMinor: subscriptionEvents.amountMinor
          })
          .from(subscriptionEvents)
          .where(
            and(
              eq(subscriptionEvents.organisationId, organisation.id),
              eq(subscriptionEvents.providerObjectType, input.providerObjectType),
              eq(subscriptionEvents.providerObjectId, input.providerObjectId),
              eq(subscriptionEvents.outcome, 'APPLIED')
            )
          )
          .orderBy(
            desc(subscriptionEvents.stripeEventCreatedAt),
            desc(persistedOperationalRiskRank),
            desc(subscriptionEvents.amountMinor),
            desc(subscriptionEvents.stripeEventId)
          )
          .limit(1);
        const previousWinner =
          latestAppliedEvidence?.status !== null &&
          latestAppliedEvidence?.status !== undefined &&
          latestAppliedEvidence.blocksSending !== null &&
          latestAppliedEvidence.amountMinor !== null
            ? {
                eventId: latestAppliedEvidence.eventId,
                eventCreatedAt: latestAppliedEvidence.eventCreatedAt,
                status: latestAppliedEvidence.status,
                blocksSending: latestAppliedEvidence.blocksSending,
                amountMinor: latestAppliedEvidence.amountMinor
              }
            : existingCase === undefined
              ? null
              : {
                  eventId: existingCase.latestProviderEventId,
                  eventCreatedAt: existingCase.latestProviderEventCreatedAt,
                  status: existingCase.status,
                  blocksSending: existingCase.blocksSending,
                  amountMinor: existingCase.amountMinor
                };
        let supersededSourceEventId: string | null = null;
        if (previousWinner !== null) {
          const incomingTime = input.eventCreatedAt.getTime();
          const previousTime = previousWinner.eventCreatedAt.getTime();
          const incomingRisk = operationalRiskRank({
            status: input.targetStatus,
            blocksSending
          });
          const previousRisk = operationalRiskRank(previousWinner);
          const greaterRefundAtSameTime =
            input.caseKind === 'REFUND' &&
            incomingTime === previousTime &&
            incomingRisk === previousRisk &&
            input.amountMinor > previousWinner.amountMinor;
          const shouldIgnore =
            incomingTime < previousTime ||
            (incomingTime === previousTime &&
              incomingRisk <= previousRisk &&
              !greaterRefundAtSameTime);
          if (shouldIgnore) {
            await insertEvent(
              transaction,
              operationalEventEvidence(input, organisation.id, blocksSending),
              'IGNORED_OUT_OF_ORDER'
            );
            return 'IGNORED_OUT_OF_ORDER';
          }
          if (incomingTime === previousTime) {
            supersededSourceEventId = previousWinner.eventId;
          }
        }

        if (existingCase === undefined && input.resolveExistingOnly) {
          await insertEvent(
            transaction,
            operationalEventEvidence(input, organisation.id, blocksSending),
            'APPLIED'
          );
          return 'APPLIED';
        }

        const actionNow = clock.now();
        const resolvedAt =
          input.targetStatus === 'RESOLVED' ? input.eventCreatedAt : null;
        const [billingCase] =
          existingCase === undefined
            ? await transaction
                .insert(billingCases)
                .values({
                  organisationId: organisation.id,
                  kind: input.caseKind,
                  status: input.targetStatus,
                  providerObjectType: input.providerObjectType,
                  providerObjectId: input.providerObjectId,
                  providerStatus: input.providerStatus,
                  stripeSubscriptionId: input.stripeSubscriptionId,
                  subscriptionRelation: relation,
                  amountMinor: input.amountMinor,
                  currency: input.currency,
                  blocksSending,
                  latestProviderEventId: input.eventId,
                  latestProviderEventCreatedAt: input.eventCreatedAt,
                  openedAt: input.eventCreatedAt,
                  resolvedAt,
                  createdAt: actionNow,
                  updatedAt: actionNow
                })
                .returning()
            : await transaction
                .update(billingCases)
                .set({
                  status: input.targetStatus,
                  providerStatus: input.providerStatus,
                  stripeSubscriptionId: input.stripeSubscriptionId,
                  subscriptionRelation: relation,
                  amountMinor: input.amountMinor,
                  currency: input.currency,
                  blocksSending,
                  latestProviderEventId: input.eventId,
                  latestProviderEventCreatedAt: input.eventCreatedAt,
                  resolvedAt,
                  updatedAt: actionNow
                })
                .where(eq(billingCases.id, existingCase.id))
                .returning();
        if (billingCase === undefined) throw new Error('BILLING_CASE_WRITE_FAILED');

        if (supersededSourceEventId !== null) {
          await transaction
            .delete(transactionalEmailOutbox)
            .where(
              and(
                eq(transactionalEmailOutbox.billingCaseId, billingCase.id),
                eq(
                  transactionalEmailOutbox.sourceEventId,
                  supersededSourceEventId
                ),
                eq(transactionalEmailOutbox.status, 'HELD')
              )
            );
        }

        if (blocksSending && organisation.platformStatus === 'ACTIVE') {
          await transaction
            .update(organisations)
            .set({
              platformStatus: 'SUSPENDED',
              platformStatusVersion: organisation.platformStatusVersion + 1,
              suspendedAt: actionNow,
              suspensionReason: 'Stripe billing risk requires owner review',
              updatedAt: actionNow
            })
            .where(eq(organisations.id, organisation.id));
          await transaction.insert(auditEvents).values({
            organisationId: organisation.id,
            eventType: 'BILLING_RISK_SUSPENDED',
            entityType: 'ORGANISATION',
            entityId: organisation.id,
            correlationId: input.eventId,
            beforeValue: { platformStatus: 'ACTIVE' },
            afterValue: {
              platformStatus: 'SUSPENDED',
              reason: 'Stripe billing risk requires owner review'
            },
            occurredAt: actionNow
          });
        }

        const createNotice = !(
          input.resolveExistingOnly && existingCase?.status === 'RESOLVED'
        );
        if (createNotice) {
          const administrators = await transaction
            .select({ userId: users.id, email: users.email })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(memberships.organisationId, organisation.id),
                eq(memberships.role, 'ADMIN'),
                isNull(memberships.disabledAt),
                isNull(users.disabledAt)
              )
            )
            .orderBy(users.id);
          const recipients = new Map<string, (typeof administrators)[number]>();
          for (const administrator of administrators) {
            const recipient = normalizedEmail(administrator.email);
            if (!validNoticeRecipient(recipient)) {
              const reason =
                recipient.length === 0
                  ? 'EMPTY'
                  : recipient.length > 320
                    ? 'TOO_LONG'
                    : 'INVALID_FORMAT';
              await transaction.insert(auditEvents).values({
                organisationId: organisation.id,
                eventType: 'BILLING_NOTICE_RECIPIENT_INVALID',
                entityType: 'USER',
                entityId: administrator.userId,
                correlationId: input.eventId,
                afterValue: { template: input.heldTemplate, reason },
                occurredAt: actionNow
              });
              continue;
            }
            if (recipients.has(recipient)) {
              await transaction.insert(auditEvents).values({
                organisationId: organisation.id,
                eventType: 'BILLING_NOTICE_RECIPIENT_DUPLICATE',
                entityType: 'USER',
                entityId: administrator.userId,
                correlationId: input.eventId,
                afterValue: { template: input.heldTemplate },
                occurredAt: actionNow
              });
              continue;
            }
            recipients.set(recipient, administrator);
          }
          if (recipients.size === 0) {
            await transaction.insert(auditEvents).values({
              organisationId: organisation.id,
              eventType: 'BILLING_NOTICE_RECIPIENT_MISSING',
              entityType: 'BILLING_CASE',
              entityId: billingCase.id,
              correlationId: input.eventId,
              afterValue: { template: input.heldTemplate },
              occurredAt: actionNow
            });
          } else {
            for (const [recipient] of recipients) {
              try {
                const inserted = await transaction.transaction(
                  async (savepoint) =>
                    savepoint
                      .insert(transactionalEmailOutbox)
                      .values({
                        organisationId: organisation.id,
                        billingCaseId: billingCase.id,
                        recipient,
                        template: input.heldTemplate,
                        templateVersion: 1,
                        renderData: {
                          caseKind: input.caseKind,
                          providerObjectId: input.providerObjectId,
                          providerStatus: input.providerStatus,
                          amountMinor: input.amountMinor,
                          currency: input.currency
                        },
                        idempotencyKey: noticeIdempotencyKey(
                          input.eventId,
                          input.heldTemplate,
                          recipient
                        ),
                        sourceEventId: input.eventId,
                        status: 'HELD',
                        attempts: 0,
                        createdAt: actionNow,
                        updatedAt: actionNow
                      })
                      .onConflictDoNothing({
                        target: [
                          transactionalEmailOutbox.organisationId,
                          transactionalEmailOutbox.idempotencyKey
                        ]
                      })
                      .returning({ id: transactionalEmailOutbox.id })
                );
                if (inserted.length === 0) {
                  await transaction.insert(auditEvents).values({
                    organisationId: organisation.id,
                    eventType: 'BILLING_NOTICE_WRITE_SKIPPED',
                    entityType: 'BILLING_CASE',
                    entityId: billingCase.id,
                    correlationId: input.eventId,
                    afterValue: {
                      template: input.heldTemplate,
                      reason: 'IDEMPOTENCY_CONFLICT'
                    },
                    occurredAt: actionNow
                  });
                }
              } catch (error) {
                await transaction.insert(auditEvents).values({
                  organisationId: organisation.id,
                  eventType: 'BILLING_NOTICE_WRITE_FAILED',
                  entityType: 'BILLING_CASE',
                  entityId: billingCase.id,
                  correlationId: input.eventId,
                  afterValue: {
                    template: input.heldTemplate,
                    failureCode: postgresErrorCode(error) ?? 'UNKNOWN'
                  },
                  occurredAt: actionNow
                });
              }
            }
          }
        }

        await transaction.insert(auditEvents).values({
          organisationId: organisation.id,
          eventType: 'BILLING_CASE_APPLIED',
          entityType: 'BILLING_CASE',
          entityId: billingCase.id,
          correlationId: input.eventId,
          beforeValue:
            existingCase === undefined
              ? null
              : {
                  status: existingCase.status,
                  blocksSending: existingCase.blocksSending
                },
          afterValue: {
            kind: input.caseKind,
            status: input.targetStatus,
            blocksSending,
            subscriptionRelation: relation
          },
          occurredAt: actionNow
        });
        await insertEvent(
          transaction,
          operationalEventEvidence(input, organisation.id, blocksSending),
          'APPLIED'
        );
        return 'APPLIED';
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        const replay = await lookupEventReplay({
          eventId: input.eventId,
          payloadHash: input.payloadHash
        });
        if (replay === 'DUPLICATE') return 'DUPLICATE';
        if (replay === 'HASH_MISMATCH') {
          throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
        }
      }
      throw error;
    }
  };

  const requestDirectDebit: SubscriptionRepository['requestDirectDebit'] =
    async (input) =>
      database.transaction(async (transaction) => {
        const [subscription] = await transaction
          .select({
            stripeCustomerId: subscriptions.stripeCustomerId,
            stripeSubscriptionId: subscriptions.stripeSubscriptionId,
            initialCardStripeSubscriptionId:
              subscriptions.initialCardStripeSubscriptionId,
            initialCardInvoiceId: subscriptions.initialCardInvoiceId,
            initialCardPaymentSucceededAt:
              subscriptions.initialCardPaymentSucceededAt
          })
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, input.organisationId))
          .for('update')
          .limit(1);
        const [administrator] = await transaction
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.organisationId, input.organisationId),
              eq(memberships.userId, input.requestedByUserId),
              eq(memberships.role, 'ADMIN'),
              isNull(memberships.disabledAt)
            )
          )
          .limit(1);
        if (administrator === undefined) {
          throw new Error('DIRECT_DEBIT_REQUEST_FORBIDDEN');
        }
        if (
          subscription === undefined ||
          subscription.stripeCustomerId === null ||
          subscription.stripeSubscriptionId === null ||
          subscription.initialCardStripeSubscriptionId !==
            subscription.stripeSubscriptionId ||
          subscription.initialCardInvoiceId === null ||
          subscription.initialCardPaymentSucceededAt === null
        ) {
          throw new Error('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');
        }
        const [existing] = await transaction
          .select()
          .from(directDebitRequests)
          .where(
            and(
              eq(directDebitRequests.organisationId, input.organisationId),
              eq(
                directDebitRequests.stripeSubscriptionId,
                subscription.stripeSubscriptionId
              )
            )
          )
          .for('update')
          .limit(1);
        if (existing !== undefined) {
          return toDirectDebitRequestRecord(existing);
        }
        const [created] = await transaction
          .insert(directDebitRequests)
          .values({
            organisationId: input.organisationId,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            requestedByUserId: input.requestedByUserId,
            requestedAt: input.requestedAt,
            createdAt: input.requestedAt,
            updatedAt: input.requestedAt
          })
          .returning();
        if (created === undefined) {
          throw new Error('DIRECT_DEBIT_REQUEST_WRITE_FAILED');
        }
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: input.requestedByUserId,
          eventType: 'DIRECT_DEBIT_REQUESTED',
          entityType: 'SUBSCRIPTION',
          entityId: input.organisationId,
          afterValue: { status: 'REQUESTED' },
          occurredAt: input.requestedAt
        });
        return toDirectDebitRequestRecord(created);
      });

  const loadDirectDebitRequest: SubscriptionRepository['loadDirectDebitRequest'] =
    async (organisationId) => {
      const [row] = await database
        .select()
        .from(directDebitRequests)
        .innerJoin(
          subscriptions,
          and(
            eq(subscriptions.organisationId, organisationId),
            eq(
              subscriptions.stripeSubscriptionId,
              directDebitRequests.stripeSubscriptionId
            )
          )
        )
        .where(eq(directDebitRequests.organisationId, organisationId))
        .limit(1);
      return row === undefined
        ? null
        : toDirectDebitRequestRecord(row.direct_debit_requests);
    };

  const loadDirectDebitRequesterEmail: SubscriptionRepository['loadDirectDebitRequesterEmail'] =
    async (organisationId) => {
      const [requester] = await database
        .select({ email: users.email })
        .from(directDebitRequests)
        .innerJoin(
          subscriptions,
          and(
            eq(
              subscriptions.organisationId,
              directDebitRequests.organisationId
            ),
            eq(
              subscriptions.stripeSubscriptionId,
              directDebitRequests.stripeSubscriptionId
            )
          )
        )
        .innerJoin(users, eq(users.id, directDebitRequests.requestedByUserId))
        .innerJoin(
          memberships,
          and(
            eq(memberships.organisationId, directDebitRequests.organisationId),
            eq(memberships.userId, directDebitRequests.requestedByUserId)
          )
        )
        .where(
          and(
            eq(directDebitRequests.organisationId, organisationId),
            eq(memberships.role, 'ADMIN'),
            isNull(memberships.disabledAt),
            isNull(users.disabledAt)
          )
        )
        .limit(1);
      return requester?.email ?? null;
    };

  const markDirectDebitSetupPending: SubscriptionRepository['markDirectDebitSetupPending'] =
    async (input) => {
      await database.transaction(async (transaction) => {
        const [subscription] = await transaction
          .select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId })
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, input.organisationId))
          .for('update')
          .limit(1);
        const [request] = await transaction
          .select()
          .from(directDebitRequests)
          .where(
            and(
              eq(directDebitRequests.id, input.directDebitRequestId),
              eq(directDebitRequests.organisationId, input.organisationId),
              eq(
                directDebitRequests.stripeSubscriptionId,
                input.stripeSubscriptionId
              )
            )
          )
          .for('update')
          .limit(1);
        if (
          subscription?.stripeSubscriptionId !== input.stripeSubscriptionId ||
          request === undefined
        ) {
          throw new Error('DIRECT_DEBIT_REQUEST_REQUIRED');
        }
        const isInitialAttempt =
          request.status === 'REQUESTED' &&
          request.setupAttemptVersion === 0 &&
          input.setupAttemptVersion === 1;
        const isExactReplay =
          request.status === 'SETUP_PENDING' &&
          request.setupAttemptVersion === input.setupAttemptVersion &&
          request.setupSessionId === input.setupSessionId &&
          request.setupSessionExpiresAt?.getTime() ===
            input.setupSessionExpiresAt.getTime();
        const isExpiredRetry =
          request.status === 'SETUP_PENDING' &&
          request.setupSessionExpiresAt !== null &&
          request.setupSessionExpiresAt <= input.occurredAt &&
          input.setupAttemptVersion === request.setupAttemptVersion + 1;
        if (!isInitialAttempt && !isExactReplay && !isExpiredRetry) {
          throw new Error('DIRECT_DEBIT_SETUP_TRANSITION_INVALID');
        }
        if (!isExactReplay) {
          await transaction
            .update(directDebitRequests)
            .set({
              status: 'SETUP_PENDING',
              setupAttemptVersion: input.setupAttemptVersion,
              setupSessionId: input.setupSessionId,
              setupSessionExpiresAt: input.setupSessionExpiresAt,
              setupCheckoutCompletedAt: null,
              setupIntentId: null,
              stripePaymentMethodId: null,
              stripeMandateId: null,
              mandateConfirmedAt: null,
              activatedByUserId: null,
              activatedAt: null,
              updatedAt: input.occurredAt
            })
            .where(
              eq(directDebitRequests.id, input.directDebitRequestId)
            );
          await transaction.insert(auditEvents).values({
            organisationId: input.organisationId,
            actorUserId: input.actorUserId,
            eventType: 'DIRECT_DEBIT_SETUP_CREATED',
            entityType: 'SUBSCRIPTION',
            entityId: input.directDebitRequestId,
            beforeValue: {
              status: request.status,
              setupAttemptVersion: request.setupAttemptVersion,
              setupSessionId: request.setupSessionId
            },
            afterValue: {
              status: 'SETUP_PENDING',
              setupAttemptVersion: input.setupAttemptVersion,
              setupSessionId: input.setupSessionId,
              setupSessionExpiresAt:
                input.setupSessionExpiresAt.toISOString()
            },
            occurredAt: input.occurredAt
          });
        }
      });
    };

  const bindDirectDebitSetupCheckout: SubscriptionRepository['bindDirectDebitSetupCheckout'] =
    async (input) => {
      try {
        return await database.transaction(async (transaction) => {
          const [duplicate] = await transaction
            .select({ payloadHash: subscriptionEvents.payloadHash })
            .from(subscriptionEvents)
            .where(eq(subscriptionEvents.stripeEventId, input.eventId))
            .limit(1);
          if (duplicate !== undefined) {
            if (duplicate.payloadHash !== input.payloadHash) {
              throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
            }
            return 'DUPLICATE';
          }
          const [subscription] = await transaction
            .select({
              stripeCustomerId: subscriptions.stripeCustomerId,
              stripeSubscriptionId: subscriptions.stripeSubscriptionId
            })
            .from(subscriptions)
            .where(eq(subscriptions.organisationId, input.organisationId))
            .for('update')
            .limit(1);
          const [request] = await transaction
            .select()
            .from(directDebitRequests)
            .where(
              and(
                eq(directDebitRequests.id, input.directDebitRequestId),
                eq(directDebitRequests.organisationId, input.organisationId),
                eq(
                  directDebitRequests.stripeSubscriptionId,
                  input.stripeSubscriptionId
                )
              )
            )
            .for('update')
            .limit(1);
          const matchesStoredSetup =
            subscription?.stripeCustomerId === input.stripeCustomerId &&
            subscription.stripeSubscriptionId === input.stripeSubscriptionId &&
            request?.status === 'SETUP_PENDING' &&
            request.setupAttemptVersion === input.setupAttemptVersion &&
            request.setupSessionId === input.setupSessionId &&
            request.setupSessionExpiresAt?.getTime() ===
              input.setupSessionExpiresAt.getTime() &&
            input.eventCreatedAt <= input.setupSessionExpiresAt &&
            (request.setupIntentId === null ||
              request.setupIntentId === input.setupIntentId);
          if (!matchesStoredSetup) {
            if (subscription !== undefined) {
              await insertEvent(transaction, input, 'REJECTED');
            }
            return 'REJECTED';
          }
          if (request.setupIntentId === null) {
            await transaction
              .update(directDebitRequests)
              .set({
                setupIntentId: input.setupIntentId,
                setupCheckoutCompletedAt: input.eventCreatedAt,
                updatedAt: clock.now()
              })
              .where(eq(directDebitRequests.id, input.directDebitRequestId));
          }
          await insertEvent(transaction, input, 'APPLIED');
          await transaction.insert(auditEvents).values({
            organisationId: input.organisationId,
            eventType: 'DIRECT_DEBIT_SETUP_COMPLETED',
            entityType: 'SUBSCRIPTION',
            entityId: input.directDebitRequestId,
            correlationId: input.eventId,
            afterValue: {
              status: 'SETUP_PENDING',
              setupAttemptVersion: input.setupAttemptVersion,
              setupSessionId: input.setupSessionId,
              setupIntentId: input.setupIntentId
            },
            occurredAt: clock.now()
          });
          return 'APPLIED';
        });
      } catch (error) {
        if (postgresErrorCode(error) === '23505') {
          const replay = await lookupEventReplay({
            eventId: input.eventId,
            payloadHash: input.payloadHash
          });
          if (replay === 'DUPLICATE') return 'DUPLICATE';
          if (replay === 'HASH_MISMATCH') {
            throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
          }
        }
        throw error;
      }
    };

  const confirmDirectDebitMandate: SubscriptionRepository['confirmDirectDebitMandate'] =
    async (input) => {
      try {
        return await database.transaction(async (transaction) => {
          const [duplicate] = await transaction
            .select({ payloadHash: subscriptionEvents.payloadHash })
            .from(subscriptionEvents)
            .where(eq(subscriptionEvents.stripeEventId, input.eventId))
            .limit(1);
          if (duplicate !== undefined) {
            if (duplicate.payloadHash !== input.payloadHash) {
              throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
            }
            return 'DUPLICATE';
          }
          const [subscription] = await transaction
            .select({
              stripeCustomerId: subscriptions.stripeCustomerId,
              stripeSubscriptionId: subscriptions.stripeSubscriptionId
            })
            .from(subscriptions)
            .where(eq(subscriptions.organisationId, input.organisationId))
            .for('update')
            .limit(1);
          const [request] = await transaction
            .select()
            .from(directDebitRequests)
            .where(
              and(
                eq(directDebitRequests.id, input.directDebitRequestId),
                eq(directDebitRequests.organisationId, input.organisationId),
                eq(
                  directDebitRequests.stripeSubscriptionId,
                  input.stripeSubscriptionId
                )
              )
            )
            .for('update')
            .limit(1);
          if (
            subscription === undefined ||
            subscription.stripeCustomerId !== input.stripeCustomerId ||
            subscription.stripeSubscriptionId !== input.stripeSubscriptionId ||
            request?.status !== 'SETUP_PENDING' ||
            request.setupAttemptVersion !== input.setupAttemptVersion ||
            request.setupSessionId === null
          ) {
            if (subscription !== undefined) {
              await insertEvent(transaction, input, 'REJECTED');
            }
            return 'REJECTED';
          }
          if (
            request.setupIntentId === null ||
            request.setupCheckoutCompletedAt === null
          ) {
            throw new Error('DIRECT_DEBIT_SETUP_CHECKOUT_REQUIRED');
          }
          if (
            request.setupIntentId !== input.setupIntentId ||
            request.setupSessionExpiresAt === null ||
            input.eventCreatedAt > request.setupSessionExpiresAt
          ) {
            await insertEvent(transaction, input, 'REJECTED');
            return 'REJECTED';
          }
          await transaction
            .update(directDebitRequests)
            .set({
              status: 'MANDATE_CONFIRMED',
              stripePaymentMethodId: input.stripePaymentMethodId,
              stripeMandateId: input.stripeMandateId,
              mandateConfirmedAt: input.eventCreatedAt,
              updatedAt: clock.now()
            })
            .where(eq(directDebitRequests.id, input.directDebitRequestId));
          await insertEvent(transaction, input, 'APPLIED');
          await transaction.insert(auditEvents).values({
            organisationId: input.organisationId,
            eventType: 'DIRECT_DEBIT_MANDATE_CONFIRMED',
            entityType: 'SUBSCRIPTION',
            entityId: input.directDebitRequestId,
            correlationId: input.eventId,
            afterValue: {
              status: 'MANDATE_CONFIRMED',
              setupIntentId: input.setupIntentId,
              mandateId: input.stripeMandateId
            },
            occurredAt: clock.now()
          });
          return 'APPLIED';
        });
      } catch (error) {
        if (postgresErrorCode(error) === '23505') {
          const replay = await lookupEventReplay({
            eventId: input.eventId,
            payloadHash: input.payloadHash
          });
          if (replay === 'DUPLICATE') return 'DUPLICATE';
          if (replay === 'HASH_MISMATCH') {
            throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
          }
        }
        throw error;
      }
    };

  const activateDirectDebit: SubscriptionRepository['activateDirectDebit'] =
    async (input) =>
      database.transaction(async (transaction) => {
        const [subscription] = await transaction
          .select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId })
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, input.organisationId))
          .for('update')
          .limit(1);
        const [request] = await transaction
          .select()
          .from(directDebitRequests)
          .where(
            and(
              eq(directDebitRequests.id, input.directDebitRequestId),
              eq(directDebitRequests.organisationId, input.organisationId),
              eq(
                directDebitRequests.stripeSubscriptionId,
                input.stripeSubscriptionId
              )
            )
          )
          .for('update')
          .limit(1);
        if (
          subscription?.stripeSubscriptionId !== input.stripeSubscriptionId ||
          request === undefined ||
          (request.status !== 'MANDATE_CONFIRMED' &&
            request.status !== 'ACTIVE') ||
          request.stripePaymentMethodId !== input.stripePaymentMethodId ||
          request.stripeMandateId !== input.stripeMandateId ||
          request.mandateConfirmedAt === null
        ) {
          throw new Error('DIRECT_DEBIT_MANDATE_REQUIRED');
        }
        if (request.status === 'ACTIVE') {
          return toDirectDebitRequestRecord(request);
        }
        const [activated] = await transaction
          .update(directDebitRequests)
          .set({
            status: 'ACTIVE',
            activatedByUserId: input.activatedByUserId,
            activatedAt: input.activatedAt,
            updatedAt: input.activatedAt
          })
          .where(eq(directDebitRequests.id, input.directDebitRequestId))
          .returning();
        if (activated === undefined) {
          throw new Error('DIRECT_DEBIT_ACTIVATION_WRITE_FAILED');
        }
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: input.activatedByUserId,
          eventType: 'DIRECT_DEBIT_ACTIVATED',
          entityType: 'SUBSCRIPTION',
          entityId: input.directDebitRequestId,
          beforeValue: { status: 'MANDATE_CONFIRMED' },
          afterValue: {
            status: 'ACTIVE',
            mandateId: input.stripeMandateId
          },
          occurredAt: input.activatedAt
        });
        return toDirectDebitRequestRecord(activated);
      });

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
            .select({ payloadHash: subscriptionEvents.payloadHash })
            .from(subscriptionEvents)
            .where(eq(subscriptionEvents.stripeEventId, input.eventId))
            .limit(1);
          if (duplicate !== undefined) {
            if (duplicate.payloadHash !== input.payloadHash) {
              throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
            }
            return 'DUPLICATE';
          }
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
        if (postgresErrorCode(error) === '23505') {
          const replay = await lookupEventReplay({
            eventId: input.eventId,
            payloadHash: input.payloadHash
          });
          if (replay === 'DUPLICATE') return 'DUPLICATE';
          if (replay === 'HASH_MISMATCH') {
            throw new Error('STRIPE_EVENT_PAYLOAD_MISMATCH');
          }
        }
        throw error;
      }
    };

  return {
    loadBillingAccount,
    lookupEventReplay,
    applyLifecycleEvent,
    applyCheckoutCompleted,
    applyOperationalEvent,
    requestDirectDebit,
    loadDirectDebitRequest,
    loadDirectDebitRequesterEmail,
    markDirectDebitSetupPending,
    bindDirectDebitSetupCheckout,
    confirmDirectDebitMandate,
    activateDirectDebit,
    recordRejectedEvent,
    recordBillingAudit
  };
};
