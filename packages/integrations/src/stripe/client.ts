import { createRequire } from 'node:module';

export const accountPulseSoloPlanCode = 'SOLO_AU_2000' as const;

export interface StripeApi {
  readonly checkout: {
    readonly sessions: {
      create(
        parameters: Record<string, unknown>,
        options: { idempotencyKey: string }
      ): Promise<unknown>;
      retrieve(sessionId: string): Promise<unknown>;
    };
  };
  readonly billingPortal: {
    readonly sessions: {
      create(parameters: Record<string, unknown>): Promise<unknown>;
    };
  };
  readonly subscriptions: {
    update(
      subscriptionId: string,
      parameters: Record<string, unknown>,
      options: { idempotencyKey: string }
    ): Promise<unknown>;
  };
  readonly charges: {
    retrieve(chargeId: string): Promise<unknown>;
  };
  readonly invoicePayments: {
    list(parameters: {
      payment: {
        type: 'payment_intent';
        payment_intent: string;
      };
      expand: string[];
      limit: number;
    }): Promise<unknown>;
  };
  readonly webhooks: {
    constructEvent(
      rawBody: string | Buffer,
      signature: string,
      secret: string,
      tolerance: number
    ): unknown;
  };
}

export interface StripeBillingConfiguration {
  readonly soloMonthlyPriceId: string;
  readonly soloAnnualPriceId?: string;
  readonly priceCurrency: 'aud';
  readonly automaticTaxEnabled: boolean;
  readonly portalConfigurationId: string;
  readonly publicBaseUrl: string;
  readonly webhookSecret: string;
  readonly webhookToleranceSeconds?: number;
}

export interface StripeRuntimeConfiguration extends StripeBillingConfiguration {
  readonly secretKey: string;
}

export type SoloBillingCadence = 'MONTHLY' | 'ANNUAL';

export interface SoloCheckoutConfiguration {
  readonly priceId: string;
  readonly automaticTaxEnabled: boolean;
  readonly publicOrigin: string;
}

export interface SoloCheckoutRequest extends SoloCheckoutConfiguration {
  readonly organisationId: string;
  readonly userId: string;
  readonly customerEmail: string | null;
  readonly stripeCustomerId?: string;
  readonly billingCadence: SoloBillingCadence;
  readonly attemptId: string;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
}

export interface StripeCheckoutSession {
  id: string;
  organisationId: string;
  attemptId: string;
  billingCadence: SoloBillingCadence;
  expiresAt: Date;
  status: 'open' | 'complete' | 'expired';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  url: string | null;
}

export interface DirectDebitSetupRequest {
  readonly organisationId: string;
  readonly userId: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly directDebitRequestId: string;
  readonly setupAttemptVersion: number;
  readonly idempotencyKey: string;
}

export interface DirectDebitActivationRequest {
  readonly stripeSubscriptionId: string;
  readonly stripePaymentMethodId: string;
  readonly idempotencyKey: string;
}

export interface StripeHostedSession {
  readonly id: string;
  readonly url: string;
}

export interface StripeHostedSetupSession extends StripeHostedSession {
  readonly expiresAt: Date;
}

export interface StripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { readonly object: unknown };
}

export interface StripeChargeOwnership {
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
}

export class StripeConfigurationFailure extends Error {
  readonly code = 'STRIPE_CONFIGURATION_INVALID';

  constructor() {
    super('Stripe billing configuration is invalid');
    this.name = 'StripeConfigurationFailure';
  }
}

export class StripeProviderFailure extends Error {
  readonly code = 'STRIPE_PROVIDER_FAILURE';

  constructor() {
    super('Stripe could not complete the requested billing operation');
    this.name = 'StripeProviderFailure';
  }
}

export class StripeWebhookSignatureFailure extends Error {
  readonly code = 'STRIPE_WEBHOOK_SIGNATURE_INVALID';

  constructor() {
    super('Stripe webhook signature is invalid');
    this.name = 'StripeWebhookSignatureFailure';
  }
}

const requireNonEmpty = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new StripeConfigurationFailure();
  return trimmed;
};

const parsePublicOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StripeConfigurationFailure();
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new StripeConfigurationFailure();
  }

  return url.origin;
};

const requireHostedSession = (value: unknown): StripeHostedSession => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('url' in value) ||
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    typeof value.url !== 'string' ||
    value.url.trim().length === 0
  ) {
    throw new StripeProviderFailure();
  }
  return { id: value.id, url: value.url };
};

const requireHostedSetupSession = (value: unknown): StripeHostedSetupSession => {
  const session = requireHostedSession(value);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('expires_at' in value) ||
    !Number.isSafeInteger(value.expires_at) ||
    (value.expires_at as number) <= 0
  ) {
    throw new StripeProviderFailure();
  }
  const expiresAt = new Date((value.expires_at as number) * 1000);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new StripeProviderFailure();
  }
  return { ...session, expiresAt };
};

const requireWebhookEvent = (value: unknown): StripeWebhookEvent => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('type' in value) ||
    !('created' in value) ||
    !('data' in value) ||
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    typeof value.type !== 'string' ||
    value.type.trim().length === 0 ||
    typeof value.created !== 'number' ||
    !Number.isSafeInteger(value.created) ||
    typeof value.data !== 'object' ||
    value.data === null ||
    !('object' in value.data)
  ) {
    throw new StripeWebhookSignatureFailure();
  }

  return {
    id: value.id,
    type: value.type,
    created: value.created,
    data: { object: value.data.object }
  };
};

const requireProviderId = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new StripeProviderFailure();
  }
  return value;
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StripeProviderFailure();
  }
  return value as Record<string, unknown>;
};

export const isStripeCheckoutAttemptId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export const parseStripeCheckoutSession = (value: unknown): StripeCheckoutSession => {
  const session = record(value);
  const metadata = record(session.metadata);
  const organisationId = requireProviderId(metadata.organisation_id);
  const attemptId = metadata.checkout_attempt_id;
  const billingCadence = metadata.billing_cadence;
  const { status } = session;
  const expiresAt = new Date(Number(session.expires_at) * 1000);
  if (
    session.object !== 'checkout.session' ||
    session.mode !== 'subscription' ||
    session.client_reference_id !== organisationId ||
    metadata.plan_code !== accountPulseSoloPlanCode ||
    !isStripeCheckoutAttemptId(attemptId) ||
    (billingCadence !== 'MONTHLY' && billingCadence !== 'ANNUAL') ||
    (status !== 'open' && status !== 'complete' && status !== 'expired') ||
    !Number.isSafeInteger(session.expires_at) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= 0
  ) {
    throw new StripeProviderFailure();
  }
  const stripeCustomerId = session.customer === null ? null : requireProviderId(session.customer);
  const stripeSubscriptionId = session.subscription === null ? null : requireProviderId(session.subscription);
  if (
    (status === 'complete' && (stripeCustomerId === null || stripeSubscriptionId === null)) ||
    (stripeSubscriptionId !== null && stripeCustomerId === null)
  ) {
    throw new StripeProviderFailure();
  }

  return {
    id: requireProviderId(session.id),
    organisationId,
    attemptId,
    billingCadence,
    expiresAt,
    status,
    stripeCustomerId,
    stripeSubscriptionId,
    url: session.url == null ? null : requireProviderId(session.url)
  };
};

const requireChargePaymentIdentity = (
  value: unknown,
  expectedChargeId: string
): { customerId: string; paymentIntentId: string } => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('object' in value) ||
    value.object !== 'charge' ||
    !('id' in value) ||
    value.id !== expectedChargeId ||
    !('customer' in value) ||
    !('payment_intent' in value)
  ) {
    throw new StripeProviderFailure();
  }

  return {
    customerId: requireProviderId(value.customer),
    paymentIntentId: requireProviderId(value.payment_intent)
  };
};

const requireChargeInvoiceOwnership = (
  value: unknown,
  chargeCustomerId: string,
  paymentIntentId: string
): StripeChargeOwnership => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('object' in value) ||
    value.object !== 'list' ||
    !('data' in value) ||
    !Array.isArray(value.data) ||
    value.data.length !== 1 ||
    !('has_more' in value) ||
    value.has_more !== false
  ) {
    throw new StripeProviderFailure();
  }

  const invoicePayment: unknown = value.data[0];
  if (
    typeof invoicePayment !== 'object' ||
    invoicePayment === null ||
    !('object' in invoicePayment) ||
    invoicePayment.object !== 'invoice_payment' ||
    !('id' in invoicePayment) ||
    typeof invoicePayment.id !== 'string' ||
    invoicePayment.id.trim().length === 0 ||
    !('payment' in invoicePayment) ||
    typeof invoicePayment.payment !== 'object' ||
    invoicePayment.payment === null ||
    !('type' in invoicePayment.payment) ||
    invoicePayment.payment.type !== 'payment_intent' ||
    !('payment_intent' in invoicePayment.payment) ||
    requireProviderId(invoicePayment.payment.payment_intent) !==
      paymentIntentId ||
    !('invoice' in invoicePayment)
  ) {
    throw new StripeProviderFailure();
  }

  const invoice: unknown = invoicePayment.invoice;
  if (
    typeof invoice !== 'object' ||
    invoice === null ||
    !('object' in invoice) ||
    invoice.object !== 'invoice' ||
    ('deleted' in invoice && invoice.deleted === true) ||
    !('customer' in invoice) ||
    requireProviderId(invoice.customer) !== chargeCustomerId ||
    !('parent' in invoice) ||
    typeof invoice.parent !== 'object' ||
    invoice.parent === null ||
    !('type' in invoice.parent) ||
    invoice.parent.type !== 'subscription_details' ||
    !('subscription_details' in invoice.parent) ||
    typeof invoice.parent.subscription_details !== 'object' ||
    invoice.parent.subscription_details === null ||
    !('subscription' in invoice.parent.subscription_details)
  ) {
    throw new StripeProviderFailure();
  }

  return {
    stripeCustomerId: chargeCustomerId,
    stripeSubscriptionId: requireProviderId(
      invoice.parent.subscription_details.subscription
    )
  };
};

export class StripeBillingClient {
  readonly #api: StripeApi;
  readonly #soloMonthlyPriceId: string;
  readonly #soloAnnualPriceId: string | null;
  readonly #automaticTaxEnabled: boolean;
  readonly #portalConfigurationId: string;
  readonly #publicOrigin: string;
  readonly #webhookSecret: string;
  readonly #webhookToleranceSeconds: number;

  constructor(api: StripeApi, configuration: StripeBillingConfiguration) {
    this.#api = api;
    this.#soloMonthlyPriceId = requireNonEmpty(
      configuration.soloMonthlyPriceId
    );
    this.#soloAnnualPriceId =
      configuration.soloAnnualPriceId === undefined
        ? null
        : requireNonEmpty(configuration.soloAnnualPriceId);
    if (this.#soloAnnualPriceId === this.#soloMonthlyPriceId) {
      throw new StripeConfigurationFailure();
    }
    if (configuration.priceCurrency !== 'aud') {
      throw new StripeConfigurationFailure();
    }
    this.#automaticTaxEnabled = configuration.automaticTaxEnabled;
    this.#portalConfigurationId = requireNonEmpty(
      configuration.portalConfigurationId
    );
    this.#publicOrigin = parsePublicOrigin(configuration.publicBaseUrl);
    this.#webhookSecret = requireNonEmpty(configuration.webhookSecret);
    this.#webhookToleranceSeconds =
      configuration.webhookToleranceSeconds ?? 300;
    if (
      !Number.isSafeInteger(this.#webhookToleranceSeconds) ||
      this.#webhookToleranceSeconds < 30 ||
      this.#webhookToleranceSeconds > 600
    ) {
      throw new StripeConfigurationFailure();
    }
  }

  checkoutConfiguration(billingCadence: SoloBillingCadence): SoloCheckoutConfiguration {
    const priceId = billingCadence === 'MONTHLY'
      ? this.#soloMonthlyPriceId
      : this.#soloAnnualPriceId;
    if (priceId === null) throw new StripeConfigurationFailure();
    return {
      priceId,
      automaticTaxEnabled: this.#automaticTaxEnabled,
      publicOrigin: this.#publicOrigin
    };
  }

  async createSoloCheckout(request: SoloCheckoutRequest): Promise<StripeCheckoutSession> {
    const organisationId = requireNonEmpty(request.organisationId);
    const userId = requireNonEmpty(request.userId);
    const priceId = requireNonEmpty(request.priceId);
    const publicOrigin = parsePublicOrigin(request.publicOrigin);
    const expiresAt = request.expiresAt.getTime() / 1000;
    if (
      !isStripeCheckoutAttemptId(request.attemptId) ||
      request.idempotencyKey !== `solo-checkout:${request.attemptId}` ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0 ||
      (request.billingCadence !== 'MONTHLY' && request.billingCadence !== 'ANNUAL')
    ) {
      throw new StripeConfigurationFailure();
    }

    const metadata = {
      organisation_id: organisationId,
      initiating_user_id: userId,
      plan_code: accountPulseSoloPlanCode,
      checkout_attempt_id: request.attemptId,
      billing_cadence: request.billingCadence
    };
    const customer = request.stripeCustomerId?.trim();
    const customerParameters = customer
      ? { customer }
      : { customer_email: requireNonEmpty(request.customerEmail ?? '') };

    try {
      const session = await this.#api.checkout.sessions.create(
        {
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          payment_method_types: ['card'],
          automatic_tax: { enabled: request.automaticTaxEnabled },
          billing_address_collection: 'required',
          tax_id_collection: { enabled: true },
          client_reference_id: organisationId,
          expires_at: expiresAt,
          ...customerParameters,
          metadata,
          subscription_data: { metadata },
          success_url: `${publicOrigin}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${publicOrigin}/settings/billing?checkout=cancelled`
        },
        { idempotencyKey: request.idempotencyKey }
      );
      return parseStripeCheckoutSession(session);
    } catch {
      throw new StripeProviderFailure();
    }
  }

  async retrieveSoloCheckout(sessionId: string): Promise<StripeCheckoutSession> {
    const id = requireNonEmpty(sessionId);
    try {
      const session = parseStripeCheckoutSession(await this.#api.checkout.sessions.retrieve(id));
      if (session.id !== id) throw new StripeProviderFailure();
      return session;
    } catch {
      throw new StripeProviderFailure();
    }
  }

  async createBillingPortal(
    stripeCustomerId: string
  ): Promise<StripeHostedSession> {
    const customer = requireNonEmpty(stripeCustomerId);
    let session: unknown;
    try {
      session = await this.#api.billingPortal.sessions.create({
        customer,
        configuration: this.#portalConfigurationId,
        return_url: `${this.#publicOrigin}/settings/billing`
      });
    } catch {
      throw new StripeProviderFailure();
    }
    return requireHostedSession(session);
  }

  async createDirectDebitSetup(
    request: DirectDebitSetupRequest
  ): Promise<StripeHostedSetupSession> {
    const organisationId = requireNonEmpty(request.organisationId);
    const userId = requireNonEmpty(request.userId);
    const customer = requireNonEmpty(request.stripeCustomerId);
    const stripeSubscriptionId = requireNonEmpty(
      request.stripeSubscriptionId
    );
    const directDebitRequestId = requireNonEmpty(
      request.directDebitRequestId
    );
    if (
      !Number.isSafeInteger(request.setupAttemptVersion) ||
      request.setupAttemptVersion < 1
    ) {
      throw new StripeConfigurationFailure();
    }
    const idempotencyKey = requireNonEmpty(request.idempotencyKey);
    const metadata = {
      organisation_id: organisationId,
      initiating_user_id: userId,
      stripe_subscription_id: stripeSubscriptionId,
      direct_debit_request_id: directDebitRequestId,
      direct_debit_setup_version: String(request.setupAttemptVersion),
      purpose: 'DIRECT_DEBIT_REQUEST'
    };
    let session: unknown;
    try {
      session = await this.#api.checkout.sessions.create(
        {
          mode: 'setup',
          customer,
          currency: 'aud',
          payment_method_types: ['au_becs_debit'],
          client_reference_id: organisationId,
          metadata,
          setup_intent_data: { metadata },
          success_url: `${this.#publicOrigin}/settings/billing?direct_debit=mandate_submitted&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.#publicOrigin}/settings/billing?direct_debit=cancelled`
        },
        { idempotencyKey }
      );
    } catch {
      throw new StripeProviderFailure();
    }
    return requireHostedSetupSession(session);
  }

  async activateDirectDebit(
    request: DirectDebitActivationRequest
  ): Promise<void> {
    const stripeSubscriptionId = requireNonEmpty(
      request.stripeSubscriptionId
    );
    const stripePaymentMethodId = requireNonEmpty(
      request.stripePaymentMethodId
    );
    const idempotencyKey = requireNonEmpty(request.idempotencyKey);
    try {
      await this.#api.subscriptions.update(
        stripeSubscriptionId,
        { default_payment_method: stripePaymentMethodId },
        { idempotencyKey }
      );
    } catch {
      throw new StripeProviderFailure();
    }
  }

  async loadChargeOwnership(chargeId: string): Promise<StripeChargeOwnership> {
    const normalizedChargeId = requireNonEmpty(chargeId);

    let charge: unknown;
    try {
      charge = await this.#api.charges.retrieve(normalizedChargeId);
    } catch {
      throw new StripeProviderFailure();
    }
    const { customerId, paymentIntentId } = requireChargePaymentIdentity(
      charge,
      normalizedChargeId
    );

    let invoicePayments: unknown;
    try {
      invoicePayments = await this.#api.invoicePayments.list({
        payment: {
          type: 'payment_intent',
          payment_intent: paymentIntentId
        },
        expand: ['data.invoice'],
        limit: 2
      });
    } catch {
      throw new StripeProviderFailure();
    }

    return requireChargeInvoiceOwnership(
      invoicePayments,
      customerId,
      paymentIntentId
    );
  }

  verifyWebhook(
    rawBody: string | Buffer,
    signature: string
  ): StripeWebhookEvent {
    const normalizedSignature = signature.trim();
    if (normalizedSignature.length === 0) {
      throw new StripeWebhookSignatureFailure();
    }

    try {
      return requireWebhookEvent(
        this.#api.webhooks.constructEvent(
          rawBody,
          normalizedSignature,
          this.#webhookSecret,
          this.#webhookToleranceSeconds
        )
      );
    } catch {
      throw new StripeWebhookSignatureFailure();
    }
  }
}

type StripeConstructor = new (secretKey: string) => StripeApi;

const requireStripeConstructor = (): StripeConstructor => {
  const loaded = createRequire(import.meta.url)('stripe') as unknown;
  const candidate =
    typeof loaded === 'object' && loaded !== null && 'default' in loaded
      ? loaded.default
      : loaded;
  if (typeof candidate !== 'function') throw new StripeConfigurationFailure();
  return candidate as StripeConstructor;
};

export const createStripeBillingClient = (
  configuration: StripeRuntimeConfiguration
): StripeBillingClient => {
  const secretKey = requireNonEmpty(configuration.secretKey);
  const Stripe = requireStripeConstructor();
  return new StripeBillingClient(new Stripe(secretKey), configuration);
};
