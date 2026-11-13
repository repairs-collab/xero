import { createHash } from 'node:crypto';

import { authorise, type AppSession } from '@bc5000/auth';
import type { DbTransaction } from '@bc5000/db';
import { hasPaidSubscriptionAccess } from '@bc5000/domain';
import type {
  AccountPulseSubscriptionStatus,
  DirectDebitActivationRequest,
  DirectDebitSetupRequest,
  SoloBillingCadence,
  SoloCheckoutConfiguration,
  SoloCheckoutRequest,
  StripeChargeOwnership,
  StripeCheckoutSession,
  StripeHostedSession,
  StripeHostedSetupSession,
  StripeWebhookEvent
} from '@bc5000/integrations/stripe';
import {
  isStripeCheckoutAttemptId,
  mapStripeSubscriptionStatus,
  parseStripeCheckoutSession,
  StripeProviderFailure
} from '@bc5000/integrations/stripe';

import { parseDirectDebitProviderReference } from './direct-debit-reconciliation.js';

export interface BillingAccount {
  organisationId: string;
  billingEmail: string;
  edition: 'INTERNAL_LEGACY' | 'SOLO';
  planCode: 'SOLO_AU_2000';
  billingCadence: 'MONTHLY' | 'ANNUAL';
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
  initialCardInvoiceId: string | null;
  initialCardStripeSubscriptionId: string | null;
  initialCardPaymentSucceededAt: Date | null;
  directDebitStatus:
    | 'REQUESTED'
    | 'SETUP_PENDING'
    | 'MANDATE_CONFIRMED'
    | 'ACTIVE'
    | 'RECONCILIATION_REQUIRED'
    | null;
  createdAt: Date;
}

export interface StripeBillingGateway {
  checkoutConfiguration(cadence: SoloBillingCadence): SoloCheckoutConfiguration;
  createSoloCheckout(request: SoloCheckoutRequest): Promise<StripeCheckoutSession>;
  retrieveSoloCheckout(sessionId: string): Promise<StripeCheckoutSession>;
  createBillingPortal(customerId: string): Promise<StripeHostedSession>;
  createDirectDebitSetup(
    request: DirectDebitSetupRequest
  ): Promise<StripeHostedSetupSession>;
  activateDirectDebit(request: DirectDebitActivationRequest): Promise<void>;
  loadChargeOwnership(chargeId: string): Promise<StripeChargeOwnership>;
  verifyWebhook(rawBody: string | Buffer, signature: string): StripeWebhookEvent;
}

export type StripeEventApplicationOutcome =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'IGNORED_OUT_OF_ORDER'
  | 'REJECTED';

export type StripeEventReplayResult =
  | 'ABSENT'
  | 'DUPLICATE'
  | 'HASH_MISMATCH';

export interface StripeLifecycleEventInput {
  organisationId: string;
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  payloadHash: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  planCode: 'SOLO_AU_2000';
  billingCadence: 'MONTHLY' | 'ANNUAL';
  status: AccountPulseSubscriptionStatus;
  stripeProviderStatus: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  cancelAt: Date | null;
  cancelledAt: Date | null;
  attemptId?: string;
  priceId?: string;
}

export interface StripeCheckoutCompletedInput {
  organisationId: string;
  eventId: string;
  eventType: 'checkout.session.completed';
  eventCreatedAt: Date;
  payloadHash: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  initialCardInvoiceId: string;
  initialCardPaymentSucceededAt: Date;
  checkoutSession?: CheckoutSessionEvidence;
}

export type CheckoutSessionEvidence = Omit<StripeCheckoutSession, 'url'>;

export interface StripeCheckoutExpiredInput {
  organisationId: string;
  eventId: string;
  eventType: 'checkout.session.expired';
  eventCreatedAt: Date;
  payloadHash: string;
  checkoutSession: CheckoutSessionEvidence;
}

export interface SoloCheckoutAttempt {
  request: SoloCheckoutRequest;
  stripeSessionId: string | null;
  reservedAt: Date;
}

export type CheckoutSessionDisposition = 'OPEN' | 'FENCED' | 'RESOLVED';

export const isTerminalStripeSubscription = (status: string | null | undefined): boolean =>
  status === 'canceled' || status === 'incomplete_expired';

export interface StripeOperationalEventInput {
  eventId: string;
  eventType:
    | 'invoice.payment_failed'
    | 'invoice.paid'
    | 'charge.refunded'
    | 'charge.dispute.created'
    | 'charge.dispute.closed';
  eventCreatedAt: Date;
  payloadHash: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  providerObjectType: 'INVOICE' | 'CHARGE' | 'DISPUTE';
  providerObjectId: string;
  providerStatus: string;
  amountMinor: number;
  currency: 'aud';
  caseKind: 'PAYMENT_FAILURE' | 'REFUND' | 'DISPUTE';
  targetStatus: 'OPEN' | 'RESOLVED' | 'REVIEW_REQUIRED';
  suspensionPolicy: 'CURRENT_ONLY' | 'ALWAYS' | 'NEVER';
  heldTemplate:
    | 'PAYMENT_FAILED'
    | 'PAYMENT_RECOVERED'
    | 'REFUND_RECORDED'
    | 'DISPUTE_OPENED'
    | 'DISPUTE_CLOSED';
  resolveExistingOnly: boolean;
}

export interface DirectDebitRequestRecord {
  id: string;
  organisationId: string;
  stripeSubscriptionId: string;
  status: 'REQUESTED' | 'SETUP_PENDING' | 'MANDATE_CONFIRMED' | 'ACTIVE';
  requestedAt: Date;
  setupAttemptVersion: number;
  setupSessionId: string | null;
  setupSessionExpiresAt: Date | null;
  setupCheckoutCompletedAt: Date | null;
  setupIntentId: string | null;
  stripePaymentMethodId: string | null;
  stripeMandateId: string | null;
  mandateConfirmedAt: Date | null;
  activatedAt: Date | null;
}

export interface DirectDebitSetupLink extends StripeHostedSetupSession {
  deliveryMode: 'MANUAL_CUSTOMER_DELIVERY';
  customerEmail: string;
}

export interface LegacyDirectDebitReconciliation {
  id: string;
  organisationId: string;
  legacyStatus:
    | 'REQUESTED'
    | 'SETUP_PENDING'
    | 'MANDATE_CONFIRMED'
    | 'ACTIVE';
  requestedAt: Date;
  providerReconciledAt: Date | null;
  providerReconciledByUserId: string | null;
  providerReconciliationOutcome:
    | 'NO_LEGACY_DEFAULT'
    | 'LEGACY_DEFAULT_REMOVED'
    | null;
  providerReconciliationReference: string | null;
}

export interface DirectDebitOwnerSnapshot {
  organisationId: string;
  billingCadence: 'MONTHLY' | 'ANNUAL';
  initialCardInvoiceId: string | null;
  initialCardPaymentSucceededAt: Date | null;
  request: (DirectDebitRequestRecord & { requesterEmail: string }) | null;
  legacyReconciliation: LegacyDirectDebitReconciliation | null;
}

export interface StripeDirectDebitMandateInput {
  organisationId: string;
  directDebitRequestId: string;
  stripeSubscriptionId: string;
  setupAttemptVersion: number;
  eventId: string;
  eventType: 'setup_intent.succeeded';
  eventCreatedAt: Date;
  payloadHash: string;
  stripeCustomerId: string;
  setupIntentId: string;
  stripePaymentMethodId: string;
  stripeMandateId: string;
}

export interface StripeDirectDebitSetupCheckoutInput {
  organisationId: string;
  directDebitRequestId: string;
  stripeSubscriptionId: string;
  setupAttemptVersion: number;
  eventId: string;
  eventType: 'checkout.session.completed';
  eventCreatedAt: Date;
  payloadHash: string;
  stripeCustomerId: string;
  setupSessionId: string;
  setupSessionExpiresAt: Date;
  setupIntentId: string;
}

export interface SubscriptionRepository {
  loadBillingAccount(
    organisationId: string,
    userId: string
  ): Promise<BillingAccount | null>;
  reserveCheckout(input: {
    organisationId: string;
    userId: string;
    billingCadence: SoloBillingCadence;
    configuration: SoloCheckoutConfiguration;
  }): Promise<SoloCheckoutAttempt>;
  recordCheckoutSession(input: CheckoutSessionEvidence): Promise<CheckoutSessionDisposition>;
  releaseRejectedCheckoutAttempt(input: {
    organisationId: string;
    attemptId: string;
    actorUserId: string;
    providerRequestId: string;
    rejectedAt: Date;
  }): Promise<boolean>;
  applyCheckoutExpired(input: StripeCheckoutExpiredInput): Promise<StripeEventApplicationOutcome>;
  applyLifecycleEvent(
    input: StripeLifecycleEventInput,
    effects?: StripeLifecycleEventEffects
  ): Promise<StripeEventApplicationOutcome>;
  applyCheckoutCompleted(
    input: StripeCheckoutCompletedInput
  ): Promise<StripeEventApplicationOutcome>;
  applyOperationalEvent(
    input: StripeOperationalEventInput
  ): Promise<StripeEventApplicationOutcome>;
  requestDirectDebit(input: {
    organisationId: string;
    requestedByUserId: string;
    requestedAt: Date;
  }): Promise<DirectDebitRequestRecord>;
  loadDirectDebitRequest(
    organisationId: string
  ): Promise<DirectDebitRequestRecord | null>;
  loadDirectDebitRequesterEmail(organisationId: string): Promise<string | null>;
  loadLegacyDirectDebitReconciliation(
    organisationId: string
  ): Promise<LegacyDirectDebitReconciliation | null>;
  reconcileLegacyDirectDebit(input: {
    organisationId: string;
    directDebitRequestId: string;
    reconciledByUserId: string;
    reconciledAt: Date;
    outcome: 'NO_LEGACY_DEFAULT' | 'LEGACY_DEFAULT_REMOVED';
    providerReference: string;
  }): Promise<LegacyDirectDebitReconciliation>;
  markDirectDebitSetupPending(input: {
    organisationId: string;
    directDebitRequestId: string;
    stripeSubscriptionId: string;
    actorUserId: string;
    setupAttemptVersion: number;
    setupSessionId: string;
    setupSessionExpiresAt: Date;
    occurredAt: Date;
  }): Promise<void>;
  bindDirectDebitSetupCheckout(
    input: StripeDirectDebitSetupCheckoutInput
  ): Promise<StripeEventApplicationOutcome>;
  confirmDirectDebitMandate(
    input: StripeDirectDebitMandateInput
  ): Promise<StripeEventApplicationOutcome>;
  activateDirectDebit(input: {
    organisationId: string;
    directDebitRequestId: string;
    stripeSubscriptionId: string;
    activatedByUserId: string;
    activatedAt: Date;
    stripePaymentMethodId: string;
    stripeMandateId: string;
  }): Promise<DirectDebitRequestRecord>;
  lookupEventReplay(input: {
    eventId: string;
    payloadHash: string;
  }): Promise<StripeEventReplayResult>;
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
      billingCadence?: 'MONTHLY' | 'ANNUAL';
    };
    occurredAt: Date;
  }): Promise<void>;
}

export interface StripeLifecycleEventEffects {
  onApplied(transaction: DbTransaction): Promise<void>;
}

export class SubscriptionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SubscriptionFailure';
  }
}

export class CheckoutAttemptConflict extends SubscriptionFailure {
  constructor(
    readonly billingCadence: 'MONTHLY' | 'ANNUAL' | null = null
  ) {
    super('CHECKOUT_ATTEMPT_CONFLICT');
    this.name = 'CheckoutAttemptConflict';
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
    input.existingStatus === 'CANCELLED' && input.existingSubscriptionId !== null &&
    input.existingSubscriptionId !== input.incomingSubscriptionId &&
    input.existingCustomerId === input.incomingCustomerId && !input.isRetired &&
    input.lastAppliedCheckoutAt != null &&
    input.eventCreatedAt.getTime() <= input.lastAppliedCheckoutAt.getTime()
  ) {
    return 'IGNORED_OUT_OF_ORDER';
  }
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

const positiveIntegerString = (value: unknown): number => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return result;
};

const directDebitMetadataFor = (
  object: Record<string, unknown>
): {
  organisationId: string;
  directDebitRequestId: string;
  stripeSubscriptionId: string;
  setupAttemptVersion: number;
} => {
  const metadata = objectValue(object.metadata);
  if (metadata.purpose !== 'DIRECT_DEBIT_REQUEST') {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return {
    organisationId: requiredString(metadata.organisation_id),
    directDebitRequestId: requiredString(
      metadata.direct_debit_request_id
    ),
    stripeSubscriptionId: requiredString(
      metadata.stripe_subscription_id
    ),
    setupAttemptVersion: positiveIntegerString(
      metadata.direct_debit_setup_version
    )
  };
};

const payloadHash = (rawBody: string | Buffer): string =>
  createHash('sha256').update(rawBody).digest('hex');

const parseAttemptCheckoutSession = (
  object: Record<string, unknown>
): CheckoutSessionEvidence => {
  try {
    return parseStripeCheckoutSession(object);
  } catch (error) {
    if (!(error instanceof StripeProviderFailure)) throw error;
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
};

const parseCheckoutExpired = (
  event: StripeWebhookEvent,
  hash: string,
  object: Record<string, unknown>
): StripeCheckoutExpiredInput => {
  const checkoutSession = parseAttemptCheckoutSession(object);
  if (checkoutSession.status !== 'expired') throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  return {
    organisationId: checkoutSession.organisationId,
    eventId: event.id,
    eventType: 'checkout.session.expired',
    eventCreatedAt: eventDate(event.created),
    payloadHash: hash,
    checkoutSession
  };
};

const parseCheckoutCompleted = (
  event: StripeWebhookEvent,
  hash: string
): StripeCheckoutCompletedInput => {
  const object = objectValue(event.data.object);
  const metadata = metadataFor(object);
  const clientReference = requiredString(object.client_reference_id);
  if (
    object.object !== 'checkout.session' ||
    object.mode !== 'subscription' ||
    object.status !== 'complete' ||
    object.payment_status !== 'paid' ||
    object.currency !== 'aud' ||
    !Number.isSafeInteger(object.amount_total) ||
    (object.amount_total as number) <= 0 ||
    !Array.isArray(object.payment_method_types) ||
    object.payment_method_types.length !== 1 ||
    object.payment_method_types[0] !== 'card'
  ) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  if (clientReference !== metadata.organisationId) {
    throw new SubscriptionFailure('STRIPE_ORGANISATION_MISMATCH');
  }
  const paidAt = eventDate(event.created);
  return {
    organisationId: metadata.organisationId,
    eventId: event.id,
    eventType: 'checkout.session.completed',
    eventCreatedAt: paidAt,
    payloadHash: hash,
    stripeCustomerId: requiredString(object.customer),
    stripeSubscriptionId: requiredString(object.subscription),
    initialCardInvoiceId: requiredString(object.invoice),
    initialCardPaymentSucceededAt: paidAt,
    ...('checkout_attempt_id' in objectValue(object.metadata)
      ? { checkoutSession: parseAttemptCheckoutSession(object) }
      : {})
  };
};

const parseLifecycleEvent = (
  event: StripeWebhookEvent,
  hash: string,
  expectedPriceIds: {
    monthly: string;
    annual: string | null;
  }
): StripeLifecycleEventInput => {
  const object = objectValue(event.data.object);
  const metadata = metadataFor(object);
  const items = objectValue(object.items);
  if (!Array.isArray(items.data) || items.data.length !== 1) {
    throw new SubscriptionFailure('STRIPE_PLAN_MISMATCH');
  }
  const item = objectValue(items.data[0]);
  const price = objectValue(item.price);
  const recurring = objectValue(price.recurring);
  const intervalCount = recurring.interval_count ?? 1;
  const stripeMetadata = objectValue(object.metadata);
  const attemptId = stripeMetadata.checkout_attempt_id;
  if ('checkout_attempt_id' in stripeMetadata && !isStripeCheckoutAttemptId(attemptId)) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  const priceId = requiredString(price.id, 'STRIPE_PLAN_MISMATCH');
  const billingCadence = recurring.interval === 'month'
    ? 'MONTHLY'
    : recurring.interval === 'year'
      ? 'ANNUAL'
      : null;
  if (
    billingCadence === null ||
    intervalCount !== 1 ||
    (attemptId === undefined
      ? priceId !== (billingCadence === 'MONTHLY' ? expectedPriceIds.monthly : expectedPriceIds.annual)
      : object.object !== 'subscription' || stripeMetadata.billing_cadence !== billingCadence) ||
    price.currency !== 'aud' ||
    object.currency !== 'aud' ||
    !Number.isSafeInteger(intervalCount)
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
    billingCadence,
    status,
    stripeProviderStatus,
    currentPeriodStart,
    currentPeriodEnd,
    trialEndsAt: nullableEventDate(object.trial_end),
    cancelAt: nullableEventDate(object.cancel_at),
    cancelledAt: nullableEventDate(object.canceled_at),
    ...(typeof attemptId === 'string' ? { attemptId, priceId } : {})
  };
};

const requiredAud = (value: unknown): 'aud' => {
  if (value !== 'aud') throw new SubscriptionFailure('STRIPE_PLAN_MISMATCH');
  return 'aud';
};

const nonNegativeMinorAmount = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return value as number;
};

const invoiceSubscriptionId = (invoice: Record<string, unknown>): string => {
  const direct =
    invoice.subscription === undefined || invoice.subscription === null
      ? null
      : requiredString(invoice.subscription);
  let parentSubscription: string | null = null;
  if (invoice.parent !== undefined && invoice.parent !== null) {
    const parent = objectValue(invoice.parent);
    if (parent.type !== 'subscription_details') {
      throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
    }
    const details = objectValue(parent.subscription_details);
    parentSubscription = requiredString(details.subscription);
  }
  if (
    direct === null &&
    parentSubscription === null
  ) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  if (
    direct !== null &&
    parentSubscription !== null &&
    direct !== parentSubscription
  ) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return direct ?? parentSubscription!;
};

const operationalEventTypes = new Set<StripeOperationalEventInput['eventType']>([
  'invoice.payment_failed',
  'invoice.paid',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed'
]);

const isOperationalEventType = (
  value: string
): value is StripeOperationalEventInput['eventType'] =>
  operationalEventTypes.has(value as StripeOperationalEventInput['eventType']);

const requireObjectDiscriminator = (
  object: Record<string, unknown>,
  expected: 'invoice' | 'charge' | 'dispute' | 'setup_intent'
): void => {
  if (object.object !== expected) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
};

const parseDirectDebitMandateEvent = (
  event: StripeWebhookEvent,
  hash: string
): StripeDirectDebitMandateInput => {
  const object = objectValue(event.data.object);
  requireObjectDiscriminator(object, 'setup_intent');
  const metadata = directDebitMetadataFor(object);
  if (
    object.status !== 'succeeded' ||
    !Array.isArray(object.payment_method_types) ||
    object.payment_method_types.length !== 1 ||
    object.payment_method_types[0] !== 'au_becs_debit'
  ) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return {
    ...metadata,
    eventId: requiredString(event.id),
    eventType: 'setup_intent.succeeded',
    eventCreatedAt: eventDate(event.created),
    payloadHash: hash,
    stripeCustomerId: requiredString(object.customer),
    setupIntentId: requiredString(object.id),
    stripePaymentMethodId: requiredString(object.payment_method),
    stripeMandateId: requiredString(object.mandate)
  };
};

const parseDirectDebitSetupCheckout = (
  event: StripeWebhookEvent,
  hash: string
): StripeDirectDebitSetupCheckoutInput => {
  const object = objectValue(event.data.object);
  const metadata = directDebitMetadataFor(object);
  const clientReference = requiredString(object.client_reference_id);
  if (
    object.object !== 'checkout.session' ||
    object.mode !== 'setup' ||
    object.status !== 'complete' ||
    object.payment_status !== 'no_payment_required' ||
    object.currency !== 'aud' ||
    !Array.isArray(object.payment_method_types) ||
    object.payment_method_types.length !== 1 ||
    object.payment_method_types[0] !== 'au_becs_debit'
  ) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  if (clientReference !== metadata.organisationId) {
    throw new SubscriptionFailure('STRIPE_ORGANISATION_MISMATCH');
  }
  const eventCreatedAt = eventDate(event.created);
  const setupSessionExpiresAt = eventDate(object.expires_at);
  if (eventCreatedAt > setupSessionExpiresAt) {
    throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
  }
  return {
    ...metadata,
    eventId: requiredString(event.id),
    eventType: 'checkout.session.completed',
    eventCreatedAt,
    payloadHash: hash,
    stripeCustomerId: requiredString(object.customer),
    setupSessionId: requiredString(object.id),
    setupSessionExpiresAt,
    setupIntentId: requiredString(object.setup_intent)
  };
};

const parseOperationalEvent = async (
  event: StripeWebhookEvent & { type: StripeOperationalEventInput['eventType'] },
  hash: string,
  stripe: StripeBillingGateway
): Promise<StripeOperationalEventInput> => {
  const object = objectValue(event.data.object);
  const common = {
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: eventDate(event.created),
    payloadHash: hash,
    currency: requiredAud(object.currency)
  } as const;

  if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') {
    requireObjectDiscriminator(object, 'invoice');
    const failed = event.type === 'invoice.payment_failed';
    const providerStatus = requiredString(object.status);
    if (providerStatus !== (failed ? 'open' : 'paid')) {
      throw new SubscriptionFailure('STRIPE_STATUS_UNSUPPORTED');
    }
    return {
      ...common,
      stripeCustomerId: requiredString(object.customer),
      stripeSubscriptionId: invoiceSubscriptionId(object),
      providerObjectType: 'INVOICE',
      providerObjectId: requiredString(object.id),
      providerStatus,
      amountMinor: nonNegativeMinorAmount(object.amount_remaining),
      caseKind: 'PAYMENT_FAILURE',
      targetStatus: failed ? 'OPEN' : 'RESOLVED',
      suspensionPolicy: failed ? 'CURRENT_ONLY' : 'NEVER',
      heldTemplate: failed ? 'PAYMENT_FAILED' : 'PAYMENT_RECOVERED',
      resolveExistingOnly: !failed
    };
  }

  if (event.type === 'charge.refunded') {
    requireObjectDiscriminator(object, 'charge');
    if (typeof object.refunded !== 'boolean') {
      throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
    }
    const providerObjectId = requiredString(object.id);
    const eventCustomerId = requiredString(object.customer);
    const ownership = await stripe.loadChargeOwnership(providerObjectId);
    if (ownership.stripeCustomerId !== eventCustomerId) {
      throw new SubscriptionFailure('STRIPE_ORGANISATION_MISMATCH');
    }
    return {
      ...common,
      stripeCustomerId: ownership.stripeCustomerId,
      stripeSubscriptionId: ownership.stripeSubscriptionId,
      providerObjectType: 'CHARGE',
      providerObjectId,
      providerStatus: object.refunded ? 'refunded' : 'partially_refunded',
      amountMinor: nonNegativeMinorAmount(object.amount_refunded),
      caseKind: 'REFUND',
      targetStatus: 'REVIEW_REQUIRED',
      suspensionPolicy: 'NEVER',
      heldTemplate: 'REFUND_RECORDED',
      resolveExistingOnly: false
    };
  }

  requireObjectDiscriminator(object, 'dispute');
  const providerStatus = requiredString(object.status);
  const createdStatuses = new Set([
    'needs_response',
    'under_review',
    'warning_needs_response',
    'warning_under_review'
  ]);
  const wonStatuses = new Set(['won', 'prevented']);
  const lostStatuses = new Set(['lost', 'warning_closed']);
  if (
    (event.type === 'charge.dispute.created' &&
      !createdStatuses.has(providerStatus)) ||
    (event.type === 'charge.dispute.closed' &&
      !wonStatuses.has(providerStatus) &&
      !lostStatuses.has(providerStatus))
  ) {
    throw new SubscriptionFailure('STRIPE_STATUS_UNSUPPORTED');
  }
  const chargeId = requiredString(object.charge);
  const ownership = await stripe.loadChargeOwnership(chargeId);
  const won = wonStatuses.has(providerStatus);
  return {
    ...common,
    stripeCustomerId: ownership.stripeCustomerId,
    stripeSubscriptionId: ownership.stripeSubscriptionId,
    providerObjectType: 'DISPUTE',
    providerObjectId: requiredString(object.id),
    providerStatus,
    amountMinor: nonNegativeMinorAmount(object.amount),
    caseKind: 'DISPUTE',
    targetStatus:
      event.type === 'charge.dispute.created'
        ? 'OPEN'
        : won
          ? 'RESOLVED'
          : 'REVIEW_REQUIRED',
    suspensionPolicy:
      event.type === 'charge.dispute.created' || !won ? 'ALWAYS' : 'NEVER',
    heldTemplate:
      event.type === 'charge.dispute.created'
        ? 'DISPUTE_OPENED'
        : 'DISPUTE_CLOSED',
    resolveExistingOnly: false
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
  soloMonthlyPriceId: string;
  soloAnnualPriceId: string | null;
  verifyPlatformOwner(userId: string): Promise<boolean>;
  clock: { now(): Date };
  enqueueLifecycle(transaction: DbTransaction, input: {
    organisationId: string;
    status: 'CANCELLED';
    eventId: string;
    stripeSubscriptionId: string;
    cancelledAt: string;
  }): Promise<void>;
  enqueueNumberProvision(transaction: DbTransaction, input: {
    organisationId: string;
    eventId: string;
  }): Promise<void>;
}) => {
  const definiteCheckoutRejection = (
    error: unknown
  ): { providerRequestId: string } | null => {
    if (typeof error !== 'object' || error === null) return null;
    const candidate = error as Record<string, unknown>;
    return candidate.code === 'STRIPE_CHECKOUT_REQUEST_REJECTED' &&
      typeof candidate.providerRequestId === 'string' &&
      /^req_[A-Za-z0-9_-]{1,124}$/u.test(candidate.providerRequestId)
      ? { providerRequestId: candidate.providerRequestId }
      : null;
  };

  const createCheckout = async (
    session: AppSession,
    organisationId: string,
    billingCadence: 'MONTHLY' | 'ANNUAL' = 'MONTHLY'
  ): Promise<StripeHostedSession> => {
    if (
      (billingCadence !== 'MONTHLY' && billingCadence !== 'ANNUAL') ||
      (billingCadence === 'ANNUAL' && dependencies.soloAnnualPriceId === null)
    ) {
      throw new SubscriptionFailure('BILLING_CADENCE_INVALID');
    }
    authorise(session, 'billing.manage', organisationId);
    const reserve = () => dependencies.repository.reserveCheckout({
      organisationId,
      userId: session.userId,
      billingCadence,
      configuration: dependencies.stripe.checkoutConfiguration(billingCadence)
    });
    const attempt = await reserve();

    const reconcile = async (value: SoloCheckoutAttempt) => {
      if (value.stripeSessionId !== null) {
        return dependencies.stripe.retrieveSoloCheckout(value.stripeSessionId);
      }
      if (
        value.request.billingCadence !== billingCadence ||
        dependencies.clock.now().getTime() >=
          value.reservedAt.getTime() + 24 * 60 * 60 * 1000
      ) {
        throw new CheckoutAttemptConflict(value.request.billingCadence);
      }
      return dependencies.stripe.createSoloCheckout(value.request);
    };

    const record = (value: SoloCheckoutAttempt, result: StripeCheckoutSession) => {
      if (
        result.attemptId !== value.request.attemptId ||
        result.organisationId !== organisationId ||
        (value.stripeSessionId !== null && result.id !== value.stripeSessionId)
      ) {
        throw new StripeProviderFailure();
      }
      return dependencies.repository.recordCheckoutSession(result);
    };

    const reconcileWithRejectedRequestRecovery = async (
      initialAttempt: SoloCheckoutAttempt
    ): Promise<{
      selectedAttempt: SoloCheckoutAttempt;
      result: StripeCheckoutSession;
    }> => {
      let selectedAttempt = initialAttempt;
      for (let recovery = 0; ; recovery += 1) {
        try {
          return {
            selectedAttempt,
            result: await reconcile(selectedAttempt)
          };
        } catch (error) {
          const rejection = definiteCheckoutRejection(error);
          if (rejection === null) throw error;
          const released = await dependencies.repository.releaseRejectedCheckoutAttempt({
            organisationId,
            attemptId: selectedAttempt.request.attemptId,
            actorUserId: session.userId,
            providerRequestId: rejection.providerRequestId,
            rejectedAt: dependencies.clock.now()
          });
          if (!released) {
            throw new CheckoutAttemptConflict(
              selectedAttempt.request.billingCadence
            );
          }
          if (recovery >= 1) throw new StripeProviderFailure();
          selectedAttempt = await reserve();
        }
      }
    };

    let { selectedAttempt, result } =
      await reconcileWithRejectedRequestRecovery(attempt);
    let disposition = await record(selectedAttempt, result);
    if (disposition === 'RESOLVED') {
      if (result.status !== 'expired') {
        throw new CheckoutAttemptConflict(
          selectedAttempt.request.billingCadence
        );
      }
      ({ selectedAttempt, result } =
        await reconcileWithRejectedRequestRecovery(await reserve()));
      disposition = await record(selectedAttempt, result);
    }
    if (
      selectedAttempt.request.billingCadence !== billingCadence ||
      disposition !== 'OPEN' ||
      result.status !== 'open' ||
      result.url === null ||
      result.expiresAt <= dependencies.clock.now()
    ) {
      throw new CheckoutAttemptConflict(selectedAttempt.request.billingCadence);
    }
    await dependencies.repository.recordBillingAudit({
      organisationId,
      actorUserId: session.userId,
      detail: {
        action: 'CHECKOUT_CREATED',
        planCode: 'SOLO_AU_2000',
        billingCadence
      },
      occurredAt: dependencies.clock.now()
    });
    return { id: result.id, url: result.url };
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

  const requestDirectDebit = async (
    session: AppSession,
    organisationId: string
  ): Promise<DirectDebitRequestRecord> => {
    authorise(session, 'billing.manage', organisationId);
    const account = requireSoloAccount(
      await dependencies.repository.loadBillingAccount(
        organisationId,
        session.userId
      )
    );
    if (account.directDebitStatus === 'RECONCILIATION_REQUIRED') {
      throw new SubscriptionFailure('DIRECT_DEBIT_RECONCILIATION_REQUIRED');
    }
    if (
      account.stripeCustomerId === null ||
      account.stripeSubscriptionId === null ||
      account.initialCardInvoiceId === null ||
      account.initialCardStripeSubscriptionId !==
        account.stripeSubscriptionId ||
      account.initialCardPaymentSucceededAt === null
    ) {
      throw new SubscriptionFailure('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');
    }
    return dependencies.repository.requestDirectDebit({
      organisationId,
      requestedByUserId: session.userId,
      requestedAt: dependencies.clock.now()
    });
  };

  const requirePlatformOwner = async (session: AppSession): Promise<void> => {
    if (!(await dependencies.verifyPlatformOwner(session.userId))) {
      throw new SubscriptionFailure('PLATFORM_OWNER_REQUIRED');
    }
  };

  const createDirectDebitSetup = async (
    session: AppSession,
    organisationId: string
  ): Promise<DirectDebitSetupLink> => {
    await requirePlatformOwner(session);
    const account = requireSoloAccount(
      await dependencies.repository.loadBillingAccount(
        organisationId,
        session.userId
      )
    );
    if (account.directDebitStatus === 'RECONCILIATION_REQUIRED') {
      throw new SubscriptionFailure('DIRECT_DEBIT_RECONCILIATION_REQUIRED');
    }
    if (
      account.stripeCustomerId === null ||
      account.stripeSubscriptionId === null ||
      account.initialCardPaymentSucceededAt === null ||
      account.initialCardStripeSubscriptionId !==
        account.stripeSubscriptionId
    ) {
      throw new SubscriptionFailure('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');
    }
    const request =
      await dependencies.repository.loadDirectDebitRequest(organisationId);
    if (
      request === null ||
      request.stripeSubscriptionId !== account.stripeSubscriptionId ||
      (request.status !== 'REQUESTED' && request.status !== 'SETUP_PENDING')
    ) {
      throw new SubscriptionFailure('DIRECT_DEBIT_REQUEST_REQUIRED');
    }
    const requesterEmail =
      await dependencies.repository.loadDirectDebitRequesterEmail(
        organisationId
      );
    if (requesterEmail === null) {
      throw new SubscriptionFailure('DIRECT_DEBIT_REQUESTER_NOT_FOUND');
    }
    const now = dependencies.clock.now();
    const setupAttemptVersion =
      request.status === 'REQUESTED'
        ? 1
        : request.setupSessionExpiresAt !== null &&
            request.setupSessionExpiresAt > now
          ? request.setupAttemptVersion
          : request.setupAttemptVersion + 1;
    const result = await dependencies.stripe.createDirectDebitSetup({
      organisationId,
      userId: session.userId,
      stripeCustomerId: account.stripeCustomerId,
      stripeSubscriptionId: account.stripeSubscriptionId,
      directDebitRequestId: request.id,
      setupAttemptVersion,
      idempotencyKey: `direct-debit-setup:${request.id}:v${setupAttemptVersion}`
    });
    if (result.expiresAt <= now) {
      throw new SubscriptionFailure('DIRECT_DEBIT_SETUP_EXPIRED');
    }
    await dependencies.repository.markDirectDebitSetupPending({
      organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: account.stripeSubscriptionId,
      actorUserId: session.userId,
      setupAttemptVersion,
      setupSessionId: result.id,
      setupSessionExpiresAt: result.expiresAt,
      occurredAt: now
    });
    const deliveryEmail =
      await dependencies.repository.loadDirectDebitRequesterEmail(
        organisationId
      );
    if (deliveryEmail === null) {
      throw new SubscriptionFailure('DIRECT_DEBIT_REQUESTER_NOT_FOUND');
    }
    return {
      ...result,
      deliveryMode: 'MANUAL_CUSTOMER_DELIVERY',
      customerEmail: deliveryEmail
    };
  };

  const activateDirectDebit = async (
    session: AppSession,
    organisationId: string
  ): Promise<DirectDebitRequestRecord> => {
    await requirePlatformOwner(session);
    const account = requireSoloAccount(
      await dependencies.repository.loadBillingAccount(
        organisationId,
        session.userId
      )
    );
    if (account.directDebitStatus === 'RECONCILIATION_REQUIRED') {
      throw new SubscriptionFailure('DIRECT_DEBIT_RECONCILIATION_REQUIRED');
    }
    const request =
      await dependencies.repository.loadDirectDebitRequest(organisationId);
    if (request?.status === 'ACTIVE') return request;
    if (
      account.stripeSubscriptionId === null ||
      request?.stripeSubscriptionId !== account.stripeSubscriptionId ||
      request?.status !== 'MANDATE_CONFIRMED' ||
      request.stripePaymentMethodId === null ||
      request.stripeMandateId === null ||
      request.mandateConfirmedAt === null
    ) {
      throw new SubscriptionFailure('DIRECT_DEBIT_MANDATE_REQUIRED');
    }
    await dependencies.stripe.activateDirectDebit({
      stripeSubscriptionId: account.stripeSubscriptionId,
      stripePaymentMethodId: request.stripePaymentMethodId,
      idempotencyKey: `direct-debit-activate:${request.id}:${request.stripeMandateId}`
    });
    return dependencies.repository.activateDirectDebit({
      organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: account.stripeSubscriptionId,
      activatedByUserId: session.userId,
      activatedAt: dependencies.clock.now(),
      stripePaymentMethodId: request.stripePaymentMethodId,
      stripeMandateId: request.stripeMandateId
    });
  };

  const reconcileLegacyDirectDebit = async (
    session: AppSession,
    organisationId: string,
    directDebitRequestId: string,
    outcome: 'NO_LEGACY_DEFAULT' | 'LEGACY_DEFAULT_REMOVED',
    providerReferenceInput: string
  ): Promise<LegacyDirectDebitReconciliation> => {
    await requirePlatformOwner(session);
    if (
      outcome !== 'NO_LEGACY_DEFAULT' &&
      outcome !== 'LEGACY_DEFAULT_REMOVED'
    ) {
      throw new SubscriptionFailure(
        'DIRECT_DEBIT_RECONCILIATION_OUTCOME_REQUIRED'
      );
    }
    let providerReference: string;
    try {
      providerReference = parseDirectDebitProviderReference(
        providerReferenceInput
      );
    } catch {
      throw new SubscriptionFailure(
        'DIRECT_DEBIT_RECONCILIATION_REFERENCE_REQUIRED'
      );
    }
    return dependencies.repository.reconcileLegacyDirectDebit({
      organisationId,
      directDebitRequestId,
      reconciledByUserId: session.userId,
      reconciledAt: dependencies.clock.now(),
      outcome,
      providerReference
    });
  };

  const getDirectDebitOwnerSnapshot = async (
    session: AppSession,
    organisationId: string
  ): Promise<DirectDebitOwnerSnapshot | null> => {
    await requirePlatformOwner(session);
    const account = await dependencies.repository.loadBillingAccount(
      organisationId,
      session.userId
    );
    if (account === null) {
      throw new SubscriptionFailure('SUBSCRIPTION_NOT_FOUND');
    }
    if (account.edition !== 'SOLO') return null;
    const request =
      await dependencies.repository.loadDirectDebitRequest(organisationId);
    const legacyReconciliation =
      await dependencies.repository.loadLegacyDirectDebitReconciliation(
        organisationId
      );
    if (
      request === null ||
      legacyReconciliation?.providerReconciledAt === null
    ) {
      return {
        organisationId,
        billingCadence: account.billingCadence,
        initialCardInvoiceId: account.initialCardInvoiceId,
        initialCardPaymentSucceededAt:
          account.initialCardPaymentSucceededAt,
        request: null,
        legacyReconciliation
      };
    }
    const requesterEmail =
      await dependencies.repository.loadDirectDebitRequesterEmail(
        organisationId
      );
    if (requesterEmail === null) {
      throw new SubscriptionFailure('DIRECT_DEBIT_REQUESTER_NOT_FOUND');
    }
    return {
      organisationId,
      billingCadence: account.billingCadence,
      initialCardInvoiceId: account.initialCardInvoiceId,
      initialCardPaymentSucceededAt: account.initialCardPaymentSucceededAt,
      request: { ...request, requesterEmail },
      legacyReconciliation
    };
  };

  const handleWebhook = async (
    rawBody: string | Buffer,
    signature: string
  ): Promise<StripeEventApplicationOutcome> => {
    const event = dependencies.stripe.verifyWebhook(rawBody, signature);
    const hash = payloadHash(rawBody);
    const replay = await dependencies.repository.lookupEventReplay({
      eventId: event.id,
      payloadHash: hash
    });
    if (replay === 'DUPLICATE') return 'DUPLICATE';
    if (replay === 'HASH_MISMATCH') {
      throw new SubscriptionFailure('STRIPE_EVENT_PAYLOAD_MISMATCH');
    }
    if (event.type === 'checkout.session.expired') {
      const object = objectValue(event.data.object);
      if (object.mode !== 'subscription' || !('checkout_attempt_id' in objectValue(object.metadata))) {
        return 'REJECTED';
      }
      return dependencies.repository.applyCheckoutExpired(parseCheckoutExpired(event, hash, object));
    }
    if (event.type === 'checkout.session.completed') {
      const object = objectValue(event.data.object);
      if (object.mode === 'setup') {
        return dependencies.repository.bindDirectDebitSetupCheckout(
          parseDirectDebitSetupCheckout(event, hash)
        );
      }
      return dependencies.repository.applyCheckoutCompleted(
        parseCheckoutCompleted(event, hash)
      );
    }
    if (event.type === 'setup_intent.succeeded') {
      return dependencies.repository.confirmDirectDebitMandate(
        parseDirectDebitMandateEvent(event, hash)
      );
    }
    if (isOperationalEventType(event.type)) {
      return dependencies.repository.applyOperationalEvent(
        await parseOperationalEvent(
          event as StripeWebhookEvent & {
            type: StripeOperationalEventInput['eventType'];
          },
          hash,
          dependencies.stripe
        )
      );
    }
    if (!event.type.startsWith('customer.subscription.')) {
      return 'REJECTED';
    }
    const object = objectValue(event.data.object);
    const identity = metadataFor(object);
    let input: StripeLifecycleEventInput;
    try {
      input = parseLifecycleEvent(event, hash, {
        monthly: dependencies.soloMonthlyPriceId,
        annual: dependencies.soloAnnualPriceId
      });
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
    const enqueueCancellation = input.status === 'CANCELLED';
    const enqueueProvisioning = hasPaidSubscriptionAccess({
      subscriptionStatus: input.status,
      stripeProviderStatus: input.stripeProviderStatus,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelAt: input.cancelAt,
      now: dependencies.clock.now()
    });
    return dependencies.repository.applyLifecycleEvent(
      input,
      enqueueCancellation || enqueueProvisioning
        ? {
            onApplied: async (transaction) => {
              if (enqueueCancellation) {
                if (input.cancelledAt === null) {
                  throw new SubscriptionFailure('STRIPE_EVENT_INVALID');
                }
                await dependencies.enqueueLifecycle(transaction, {
                  organisationId: input.organisationId,
                  status: 'CANCELLED',
                  eventId: input.eventId,
                  stripeSubscriptionId: input.stripeSubscriptionId,
                  cancelledAt: input.cancelledAt.toISOString()
                });
              }
              if (enqueueProvisioning) {
                await dependencies.enqueueNumberProvision(transaction, {
                  organisationId: input.organisationId,
                  eventId: input.eventId
                });
              }
            }
          }
        : undefined
    );
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

  return {
    createCheckout,
    createPortal,
    requestDirectDebit,
    createDirectDebitSetup,
    activateDirectDebit,
    reconcileLegacyDirectDebit,
    getDirectDebitOwnerSnapshot,
    handleWebhook,
    getBillingAccount
  };
};
