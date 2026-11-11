import { createHash } from 'node:crypto';

import { authorise, type AppSession } from '@bc5000/auth';
import { hasPaidSubscriptionAccess } from '@bc5000/domain';
import type {
  AccountPulseSubscriptionStatus,
  SoloCheckoutRequest,
  StripeHostedSession,
  StripeWebhookEvent
} from '@bc5000/integrations/stripe';
import { mapStripeSubscriptionStatus } from '@bc5000/integrations/stripe';

export interface BillingAccount {
  organisationId: string;
  billingEmail: string;
  edition: 'INTERNAL_LEGACY' | 'SOLO';
  planCode: 'SOLO_AU_2000';
  status: AccountPulseSubscriptionStatus;
  stripeProviderStatus?: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAt: Date | null;
  cancelledAt: Date | null;
  lastStripeEventCreatedAt: Date | null;
  createdAt: Date;
}

export interface StripeBillingGateway {
  createSoloCheckout(request: SoloCheckoutRequest): Promise<StripeHostedSession>;
  createBillingPortal(customerId: string): Promise<StripeHostedSession>;
  verifyWebhook(rawBody: string | Buffer, signature: string): StripeWebhookEvent;
}

export type StripeEventApplicationOutcome =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'IGNORED_OUT_OF_ORDER'
  | 'REJECTED';

export interface StripeLifecycleEventInput {
  organisationId: string;
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  payloadHash: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  planCode: 'SOLO_AU_2000';
  status: AccountPulseSubscriptionStatus;
  stripeProviderStatus: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  cancelAt: Date | null;
  cancelledAt: Date | null;
}

export interface StripeCheckoutCompletedInput {
  organisationId: string;
  eventId: string;
  eventType: 'checkout.session.completed';
  eventCreatedAt: Date;
  payloadHash: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
}

export interface SubscriptionRepository {
  loadBillingAccount(
    organisationId: string,
    userId: string
  ): Promise<BillingAccount | null>;
  applyLifecycleEvent(
    input: StripeLifecycleEventInput
  ): Promise<StripeEventApplicationOutcome>;
  applyCheckoutCompleted(
    input: StripeCheckoutCompletedInput
  ): Promise<StripeEventApplicationOutcome>;
  recordRejectedEvent(input: {
    organisationId: string;
    eventId: string;
    eventType: string;
    eventCreatedAt: Date;
    payloadHash: string;
  }): Promise<'REJECTED' | 'DUPLICATE'>;
  recordBillingAudit(input: {
    organisationId: string;
    actorUserId: string;
    detail: {
      action: 'CHECKOUT_CREATED' | 'PORTAL_OPENED';
      planCode: 'SOLO_AU_2000';
    };
    occurredAt: Date;
  }): Promise<void>;
}

export class SubscriptionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SubscriptionFailure';
  }
}

interface StripeEventDecisionInput {
  eventAlreadyProcessed: boolean;
  eventCreatedAt: Date;
  lastAppliedAt: Date | null;
  lastAppliedCheckoutAt?: Date | null;
  existingCustomerId: string | null;
  incomingCustomerId: string;
  existingSubscriptionId: string | null;
  incomingSubscriptionId: string;
  existingStatus?: AccountPulseSubscriptionStatus;
  incomingStatus?: AccountPulseSubscriptionStatus;
  allowReplacement?: boolean;
  isRetired?: boolean;
}

export const decideStripeEventApplication = (
  input: StripeEventDecisionInput
): StripeEventApplicationOutcome => {
  if (input.eventAlreadyProcessed) return 'DUPLICATE';
  if (
    (input.existingCustomerId !== null &&
      input.existingCustomerId !== input.incomingCustomerId) ||
    (input.existingSubscriptionId !== null &&
      input.existingSubscriptionId !== input.incomingSubscriptionId &&
      !(input.allowReplacement && input.existingStatus === 'CANCELLED' && input.existingCustomerId !== null && input.existingCustomerId === input.incomingCustomerId)) || input.isRetired
  ) {
    return 'REJECTED';
  }
  if (
    input.lastAppliedAt !== null &&
    input.eventCreatedAt.getTime() < input.lastAppliedAt.getTime()
  ) {
    return 'IGNORED_OUT_OF_ORDER';
  }
  if (input.existingStatus === 'CANCELLED' && input.existingSubscriptionId !== null &&
    input.existingSubscriptionId !== input.incomingSubscriptionId && input.lastAppliedCheckoutAt != null &&
    input.eventCreatedAt.getTime() <= input.lastAppliedCheckoutAt.getTime()) {
    return 'IGNORED_OUT_OF_ORDER';
  }
  const risk: Record<AccountPulseSubscriptionStatus, number> = {
    ACTIVE: 0,
    CANCEL_AT_PERIOD_END: 1,
    TRIALING: 2,
    PAST_DUE: 3,
    INCOMPLETE: 3,
    CANCELLED: 3
  };
  if (input.lastAppliedAt !== null && input.eventCreatedAt.getTime() === input.lastAppliedAt.getTime() && input.existingStatus !== undefined && input.incomingStatus !== undefined &&
    risk[input.incomingStatus] <= risk[input.existingStatus]) {
    return 'IGNORED_OUT_OF_ORDER';
  }
  return 'APPLIED';
};

export const shouldRetireIgnoredReplacementCandidate = (input: {
  outcome: StripeEventApplicationOutcome;
  existingStatus: AccountPulseSubscriptionStatus;
  existingCustomerId: string | null;
  incomingCustomerId: string;
  existingSubscriptionId: string | null;
  incomingSubscriptionId: string;
}): boolean =>
  input.outcome === 'IGNORED_OUT_OF_ORDER' &&
  input.existingStatus === 'CANCELLED' &&
  input.existingCustomerId !== null &&
  input.existingCustomerId === input.incomingCustomerId &&
  input.existingSubscriptionId !== null &&
  input.existingSubscriptionId !== input.incomingSubscriptionId;

export const retainedTrialEnd = (local: Date | null, incoming: Date | null): Date | null =>
  local === null || incoming === null ? local : new Date(Math.min(local.getTime(), incoming.getTime()));

const objectValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return value as Record<string, unknown>;
};

const requiredString = (
  value: unknown,
  code = 'STRIPE_EVENT_INVALID'
): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SubscriptionFailure(code);
  }
  return value.trim();
};

const eventDate = (value: unknown): Date => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  const result = new Date((value as number) * 1000);
  if (!Number.isFinite(result.getTime())) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return result;
};

const nullableEventDate = (value: unknown): Date | null =>
  value === null ? null : eventDate(value);

const metadataFor = (
  object: Record<string, unknown>
): { organisationId: string; planCode: 'SOLO_AU_2000' } => {
  const metadata = objectValue(object.metadata);
  const organisationId = requiredString(metadata.organisation_id);
  if (metadata.plan_code !== 'SOLO_AU_2000') {
    throw new SubscriptionFailure('STRIPE_PLAN_MISMATCH');
  }
  return { organisationId, planCode: 'SOLO_AU_2000' };
};

const payloadHash = (rawBody: string | Buffer): string =>
  createHash('sha256').update(rawBody).digest('hex');

const parseCheckoutCompleted = (
  event: StripeWebhookEvent,
  hash: string
): StripeCheckoutCompletedInput => {
  const object = objectValue(event.data.object);
  const metadata = metadataFor(object);
  const clientReference = requiredString(object.client_reference_id);
  if (clientReference !== metadata.organisationId) {
    throw new SubscriptionFailure('STRIPE_ORGANISATION_MISMATCH');
  }
  return {
    organisationId: metadata.organisationId,
    eventId: event.id,
    eventType: 'checkout.session.completed',
    eventCreatedAt: eventDate(event.created),
    payloadHash: hash,
    stripeCustomerId: requiredString(object.customer),
    stripeSubscriptionId: requiredString(object.subscription)
  };
};

const parseLifecycleEvent = (
  event: StripeWebhookEvent,
  hash: string,
  expectedPriceId: string
): StripeLifecycleEventInput => {
  const object = objectValue(event.data.object);
  const metadata = metadataFor(object);
  const items = objectValue(object.items);
  if (!Array.isArray(items.data) || items.data.length !== 1) {
    throw new SubscriptionFailure('STRIPE_PLAN_MISMATCH');
  }
  const item = objectValue(items.data[0]);
  const price = objectValue(item.price);
  if (
    price.id !== expectedPriceId ||
    price.currency !== 'aud' ||
    object.currency !== 'aud' ||
    typeof price.recurring !== 'object' ||
    price.recurring === null
  ) {
    throw new SubscriptionFailure('STRIPE_PLAN_MISMATCH');
  }
  const hasItemPeriod = item.current_period_start !== undefined || item.current_period_end !== undefined;
  const currentPeriodStart = eventDate(hasItemPeriod ? item.current_period_start : object.current_period_start);
  const currentPeriodEnd = eventDate(hasItemPeriod ? item.current_period_end : object.current_period_end);
  if (currentPeriodEnd <= currentPeriodStart) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  if (typeof object.cancel_at_period_end !== 'boolean') {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  const stripeProviderStatus = requiredString(object.status);
  let status: AccountPulseSubscriptionStatus;
  try {
    status = mapStripeSubscriptionStatus(
      stripeProviderStatus,
      object.cancel_at_period_end
    );
  } catch {
    throw new SubscriptionFailure('STRIPE_STATUS_UNSUPPORTED');
  }
  return {
    organisationId: metadata.organisationId,
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: eventDate(event.created),
    payloadHash: hash,
    stripeCustomerId: requiredString(object.customer),
    stripeSubscriptionId: requiredString(object.id),
    planCode: metadata.planCode,
    status,
    stripeProviderStatus,
    currentPeriodStart,
    currentPeriodEnd,
    trialEndsAt: nullableEventDate(object.trial_end),
    cancelAt: nullableEventDate(object.cancel_at),
    cancelledAt: nullableEventDate(object.canceled_at)
  };
};

const requireSoloAccount = (
  account: BillingAccount | null
): BillingAccount => {
  if (account === null) throw new SubscriptionFailure('SUBSCRIPTION_NOT_FOUND');
  if (account.edition !== 'SOLO') {
    throw new SubscriptionFailure('BILLING_NOT_APPLICABLE');
  }
  return account;
};

export const createSubscriptionService = (dependencies: {
  stripe: StripeBillingGateway;
  repository: SubscriptionRepository;
  soloPriceId: string;
  clock: { now(): Date };
  publishLifecycle(input: {
    organisationId: string;
    status: 'CANCELLED';
  }): Promise<void>;
  publishNumberProvision(input: { organisationId: string }): Promise<void>;
}) => {
  const createCheckout = async (
    session: AppSession,
    organisationId: string
  ): Promise<StripeHostedSession> => {
    authorise(session, 'billing.manage', organisationId);
    const account = requireSoloAccount(
      await dependencies.repository.loadBillingAccount(
        organisationId,
        session.userId
      )
    );
    if (
      account.stripeSubscriptionId !== null &&
      account.status !== 'CANCELLED'
    ) {
      throw new SubscriptionFailure('CHECKOUT_NOT_AVAILABLE');
    }
    const attemptVersion =
      account.lastStripeEventCreatedAt ?? account.createdAt;
    const result = await dependencies.stripe.createSoloCheckout({
      organisationId,
      userId: session.userId,
      customerEmail: account.billingEmail,
      ...(account.trialEndsAt !== null && Math.floor(account.trialEndsAt.getTime() / 1000) >= Math.ceil(dependencies.clock.now().getTime() / 1000) + 48 * 60 * 60 + 300
        ? { trialEnd: Math.floor(account.trialEndsAt.getTime() / 1000) }
        : {}),
      ...(account.stripeCustomerId === null
        ? {}
        : { stripeCustomerId: account.stripeCustomerId }),
      idempotencyKey: `solo-checkout:${organisationId}:${attemptVersion.toISOString()}`
    });
    await dependencies.repository.recordBillingAudit({
      organisationId,
      actorUserId: session.userId,
      detail: { action: 'CHECKOUT_CREATED', planCode: 'SOLO_AU_2000' },
      occurredAt: dependencies.clock.now()
    });
    return result;
  };

  const createPortal = async (
    session: AppSession,
    organisationId: string
  ): Promise<StripeHostedSession> => {
    authorise(session, 'billing.manage', organisationId);
    const account = requireSoloAccount(
      await dependencies.repository.loadBillingAccount(
        organisationId,
        session.userId
      )
    );
    if (account.stripeCustomerId === null) {
      throw new SubscriptionFailure('STRIPE_CUSTOMER_NOT_FOUND');
    }
    const result = await dependencies.stripe.createBillingPortal(
      account.stripeCustomerId
    );
    await dependencies.repository.recordBillingAudit({
      organisationId,
      actorUserId: session.userId,
      detail: { action: 'PORTAL_OPENED', planCode: 'SOLO_AU_2000' },
      occurredAt: dependencies.clock.now()
    });
    return result;
  };

  const handleWebhook = async (
    rawBody: string | Buffer,
    signature: string
  ): Promise<StripeEventApplicationOutcome> => {
    const event = dependencies.stripe.verifyWebhook(rawBody, signature);
    const hash = payloadHash(rawBody);
    if (event.type === 'checkout.session.completed') {
      return dependencies.repository.applyCheckoutCompleted(
        parseCheckoutCompleted(event, hash)
      );
    }
    if (!event.type.startsWith('customer.subscription.')) {
      return 'REJECTED';
    }
    const object = objectValue(event.data.object);
    const identity = metadataFor(object);
    let input: StripeLifecycleEventInput;
    try {
      input = parseLifecycleEvent(event, hash, dependencies.soloPriceId);
    } catch (error) {
      if (
        error instanceof SubscriptionFailure &&
        error.code === 'STRIPE_PLAN_MISMATCH'
      ) {
        return dependencies.repository.recordRejectedEvent({
          organisationId: identity.organisationId,
          eventId: event.id,
          eventType: event.type,
          eventCreatedAt: eventDate(event.created),
          payloadHash: hash
        });
      }
      throw error;
    }
    const outcome = await dependencies.repository.applyLifecycleEvent(input);
    if (
      (outcome === 'APPLIED' || outcome === 'DUPLICATE') &&
      input.status === 'CANCELLED'
    ) {
      await dependencies.publishLifecycle({
        organisationId: input.organisationId,
        status: 'CANCELLED'
      });
    }
    if (
      (outcome === 'APPLIED' || outcome === 'DUPLICATE') &&
      hasPaidSubscriptionAccess({ subscriptionStatus: input.status, stripeProviderStatus: input.stripeProviderStatus, currentPeriodEnd: input.currentPeriodEnd, cancelAt: input.cancelAt, now: dependencies.clock.now() })
    ) {
      await dependencies.publishNumberProvision({
        organisationId: input.organisationId
      });
    }
    return outcome;
  };

  const getBillingAccount = async (
    session: AppSession,
    organisationId: string
  ): Promise<BillingAccount> => {
    const membership = session.memberships.find(
      (value) => value.organisationId === organisationId && value.active
    );
    if (membership === undefined) throw new SubscriptionFailure('FORBIDDEN');
    return requireSoloAccount(
      await dependencies.repository.loadBillingAccount(
        organisationId,
        session.userId
      )
    );
  };

  return { createCheckout, createPortal, handleWebhook, getBillingAccount };
};
