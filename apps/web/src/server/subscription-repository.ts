import { createHash } from 'node:crypto';

import { and, desc, eq, isNull, or } from 'drizzle-orm';

import {
  auditEvents,
  billingCases,
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
  type StripeCheckoutCompletedInput,
  type StripeEventApplicationOutcome,
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

const normalizedEmail = (value: string): string =>
  value.trim().toLocaleLowerCase('en-AU');

const noticeIdempotencyKey = (
  eventId: string,
  template: StripeOperationalEventInput['heldTemplate'],
  recipient: string
): string =>
  `stripe:${eventId}:${template}:v1:${createHash('sha256').update(recipient).digest('hex')}`;

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
        stripeProviderStatus: subscriptions.trustedStripeProviderStatus,
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
        await transaction
          .update(subscriptions)
          .set({
            status: input.status,
            stripeProviderStatus: input.stripeProviderStatus,
            stripeCustomerId: input.stripeCustomerId,
            stripeSubscriptionId: input.stripeSubscriptionId,
            currentPeriodStart: input.currentPeriodStart,
            currentPeriodEnd: input.currentPeriodEnd,
            trialEndsAt: retainedTrialEnd(subscription.trialEndsAt, input.trialEndsAt),
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

  const applyOperationalEvent = async (
    input: StripeOperationalEventInput
  ): Promise<StripeEventApplicationOutcome> => {
    try {
      return await database.transaction(async (transaction) => {
        const [duplicate] = await transaction
          .select({ id: subscriptionEvents.id })
          .from(subscriptionEvents)
          .where(eq(subscriptionEvents.stripeEventId, input.eventId))
          .limit(1);
        if (duplicate !== undefined) return 'DUPLICATE';

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
        if (
          (currentCandidate === undefined && retiredCandidate === undefined) ||
          (currentCandidate !== undefined && retiredCandidate !== undefined)
        ) {
          return 'REJECTED';
        }
        const relation =
          currentCandidate !== undefined ? ('CURRENT' as const) : ('RETIRED' as const);
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
          subscription.stripeCustomerId !== input.stripeCustomerId ||
          (relation === 'CURRENT' &&
            subscription.stripeSubscriptionId !== input.stripeSubscriptionId)
        ) {
          return 'REJECTED';
        }
        if (relation === 'RETIRED') {
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
          if (retired?.organisationId !== organisation.id) return 'REJECTED';
        }

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
        const blocksSending = operationalEventBlocksSending(input, relation);
        if (existingCase !== undefined) {
          const incomingTime = input.eventCreatedAt.getTime();
          const existingTime = existingCase.latestProviderEventCreatedAt.getTime();
          const lowerOrEqualRiskAtSameTime =
            incomingTime === existingTime &&
            operationalRiskRank({
              status: input.targetStatus,
              blocksSending
            }) <=
              operationalRiskRank({
                status: existingCase.status,
                blocksSending: existingCase.blocksSending
              });
          if (incomingTime < existingTime || lowerOrEqualRiskAtSameTime) {
            await insertEvent(
              transaction,
              { ...input, organisationId: organisation.id },
              'IGNORED_OUT_OF_ORDER'
            );
            return 'IGNORED_OUT_OF_ORDER';
          }
        }

        if (existingCase === undefined && input.resolveExistingOnly) {
          await insertEvent(
            transaction,
            { ...input, organisationId: organisation.id },
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
          if (administrators.length === 0) {
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
            for (const administrator of administrators) {
              const recipient = normalizedEmail(administrator.email);
              await transaction.insert(transactionalEmailOutbox).values({
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
                status: 'HELD',
                attempts: 0,
                createdAt: actionNow,
                updatedAt: actionNow
              });
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
          { ...input, organisationId: organisation.id },
          'APPLIED'
        );
        return 'APPLIED';
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
    applyOperationalEvent,
    recordRejectedEvent,
    recordBillingAudit
  };
};
