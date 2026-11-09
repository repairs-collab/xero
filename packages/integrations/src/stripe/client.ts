import { createRequire } from 'node:module';

export const accountPulseSoloPlanCode = 'SOLO_AU_2000' as const;

export interface StripeApi {
  readonly checkout: {
    readonly sessions: {
      create(
        parameters: Record<string, unknown>,
        options: { idempotencyKey: string }
      ): Promise<unknown>;
    };
  };
  readonly billingPortal: {
    readonly sessions: {
      create(parameters: Record<string, unknown>): Promise<unknown>;
    };
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
  readonly soloPriceId: string;
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

export interface SoloCheckoutRequest {
  readonly organisationId: string;
  readonly userId: string;
  readonly customerEmail: string;
  readonly stripeCustomerId?: string;
  readonly idempotencyKey: string;
}

export interface StripeHostedSession {
  readonly id: string;
  readonly url: string;
}

export interface StripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { readonly object: unknown };
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
    super('Stripe could not create the requested billing session');
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

export class StripeBillingClient {
  readonly #api: StripeApi;
  readonly #soloPriceId: string;
  readonly #automaticTaxEnabled: boolean;
  readonly #portalConfigurationId: string;
  readonly #publicOrigin: string;
  readonly #webhookSecret: string;
  readonly #webhookToleranceSeconds: number;

  constructor(api: StripeApi, configuration: StripeBillingConfiguration) {
    this.#api = api;
    this.#soloPriceId = requireNonEmpty(configuration.soloPriceId);
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

  async createSoloCheckout(
    request: SoloCheckoutRequest
  ): Promise<StripeHostedSession> {
    const organisationId = requireNonEmpty(request.organisationId);
    const userId = requireNonEmpty(request.userId);
    const idempotencyKey = requireNonEmpty(request.idempotencyKey);
    const metadata = {
      organisation_id: organisationId,
      initiating_user_id: userId,
      plan_code: accountPulseSoloPlanCode
    };
    const customer = request.stripeCustomerId?.trim();
    const customerParameters = customer
      ? { customer }
      : { customer_email: requireNonEmpty(request.customerEmail) };

    let session: unknown;
    try {
      session = await this.#api.checkout.sessions.create(
        {
          mode: 'subscription',
          line_items: [{ price: this.#soloPriceId, quantity: 1 }],
          automatic_tax: { enabled: this.#automaticTaxEnabled },
          billing_address_collection: 'required',
          tax_id_collection: { enabled: true },
          client_reference_id: organisationId,
          ...customerParameters,
          metadata,
          subscription_data: {
            trial_period_days: 14,
            metadata
          },
          success_url: `${this.#publicOrigin}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.#publicOrigin}/settings/billing?checkout=cancelled`
        },
        { idempotencyKey }
      );
    } catch {
      throw new StripeProviderFailure();
    }

    return requireHostedSession(session);
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
