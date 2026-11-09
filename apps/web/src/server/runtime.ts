import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual
} from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import {
  type AppSession,
  type CognitoConfiguration,
  requireIdentitySession,
  requireSession
} from '@bc5000/auth';
import {
  auditEvents,
  createDatabase,
  memberships,
  organisations,
  PostgresSmsCommerceRepository,
  PostgresXeroConnectionRepository,
  type DatabaseClient
} from '@bc5000/db/web';
import { FetchHttpClient } from '@bc5000/integrations/http';
import {
  createStripeBillingClient,
  type StripeRuntimeConfiguration
} from '@bc5000/integrations/stripe';
import { VoiceGatewayClient } from '@bc5000/integrations/voice-gateway';
import {
  AesGcmTokenCipher,
  XeroClient,
  XeroOAuthClient,
  XeroOAuthSessionProvider,
  type TokenCipher
} from '@bc5000/integrations/xero';
import { ensureRecurringSchedules, jobNames } from '@bc5000/jobs';

import {
  createOnboardingService,
  createPostgresOnboardingRepository
} from '../app/onboarding/onboarding-service.js';
import {
  createMobileVerificationService,
  createPostgresMobileVerificationRepository
} from '../app/onboarding/mobile-verification-service.js';
import { getJobQueue } from './job-runtime.js';
import { PostgresMembershipLoader } from './membership-loader.js';
import {
  createPostgresSoloProvisioningRepository,
  createSoloProvisioningService
} from './solo-provisioning-service.js';
import { createPostgresSubscriptionRepository } from './subscription-repository.js';
import { createSubscriptionService } from './subscription-service.js';
import { createXeroOAuthService } from './xero-oauth-service.js';

let databaseClient: DatabaseClient | undefined;
let xeroOAuthService:
  | ReturnType<typeof createXeroOAuthService>
  | undefined;
let subscriptionServicePromise:
  | Promise<ReturnType<typeof createSubscriptionService>>
  | undefined;

interface VoicePreviewSessionClaims {
  organisationId: string;
  userId: string;
  callFlowHash: string;
  callFlowVersion: number;
  configurationVersion: number;
  voipcloudUserNumber: string;
  gatewayFlowVersion: number;
  ttsVoiceId: string;
  sessionId: string;
  expiresAt: number;
}

const encodePreviewClaims = (claims: VoicePreviewSessionClaims): string =>
  Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');

const signPreviewClaims = (encoded: string): string =>
  createHmac('sha256', getSessionSecret())
    .update(encoded)
    .digest('base64url');

export const issueVoicePreviewSession = (input: {
  organisationId: string;
  userId: string;
  callFlowHash: string;
  callFlowVersion: number;
  configurationVersion: number;
  voipcloudUserNumber: string;
  gatewayFlowVersion: number;
  ttsVoiceId: string;
  now?: Date;
}): { sessionId: string; token: string } => {
  const sessionId = randomUUID();
  const { now, ...configuration } = input;
  const claims: VoicePreviewSessionClaims = {
    ...configuration,
    sessionId,
    expiresAt: (now ?? new Date()).getTime() + 30 * 60 * 1000
  };
  const encoded = encodePreviewClaims(claims);
  return { sessionId, token: `${encoded}.${signPreviewClaims(encoded)}` };
};

const parseVoicePreviewSession = (token: string): VoicePreviewSessionClaims => {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (
    encoded === undefined ||
    suppliedSignature === undefined ||
    extra !== undefined
  ) {
    throw new Error('VOICE_PREVIEW_SESSION_INVALID');
  }
  const expectedSignature = signPreviewClaims(encoded);
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('VOICE_PREVIEW_SESSION_INVALID');
  }
  try {
    return JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as VoicePreviewSessionClaims;
  } catch {
    throw new Error('VOICE_PREVIEW_SESSION_INVALID');
  }
};

export const verifyVoicePreviewSession = (input: {
  organisationId: string;
  userId: string;
  previewSessionToken: string;
  callFlowHash: string;
  callFlowVersion: number;
  configurationVersion: number;
  voipcloudUserNumber: string;
  gatewayFlowVersion: number;
  ttsVoiceId: string;
}): Promise<{ sessionId: string; passed: boolean }> => {
  const claims = parseVoicePreviewSession(input.previewSessionToken);
  if (
    claims.expiresAt < Date.now() ||
    claims.organisationId !== input.organisationId ||
    claims.userId !== input.userId ||
    claims.callFlowHash !== input.callFlowHash ||
    claims.callFlowVersion !== input.callFlowVersion ||
    claims.configurationVersion !== input.configurationVersion ||
    claims.voipcloudUserNumber !== input.voipcloudUserNumber ||
    claims.gatewayFlowVersion !== input.gatewayFlowVersion ||
    claims.ttsVoiceId !== input.ttsVoiceId
  ) {
    throw new Error('VOICE_PREVIEW_SESSION_INVALID');
  }
  return Promise.resolve({ sessionId: claims.sessionId, passed: true });
};

export const getVoiceProviderTester = () => ({
  test: async (input: {
    provider: 'VOIPCLOUD';
    voipcloudUserNumber: string;
    gatewayFlowVersion: number;
  }) => {
    const signingSecret = process.env.VOICE_GATEWAY_SIGNING_SECRET;
    if (signingSecret === undefined || signingSecret.trim() === '') {
      throw new Error('VOICE_GATEWAY_SIGNING_SECRET is required');
    }
    const client = new VoiceGatewayClient({
      http: new FetchHttpClient(),
      signingSecret,
      baseUrl: process.env.VOICE_GATEWAY_URL ?? 'http://voice-gateway:3105'
    });
    const health = await client.health();
    return {
      provider: input.provider,
      endpoint: 'https://au.voipcloud.online/api/integration/v2',
      credentialsConfigured: true,
      gatewayReady: health.ready,
      gatewayFlowVersion: health.version,
      customerCallsEnabled: health.callsEnabled
    };
  }
});

export const getDatabaseClient = (): DatabaseClient => {
  databaseClient ??= createDatabase(
    process.env.DATABASE_URL ??
      'postgres://bc5000:bc5000@localhost:5432/bc5000'
  );
  return databaseClient;
};

export const getSessionSecret = (): Uint8Array => {
  const encoded = process.env.SESSION_SECRET_BASE64;
  if (encoded === undefined) {
    throw new Error('SESSION_SECRET_BASE64 is required');
  }
  const secret = Buffer.from(encoded, 'base64');
  if (secret.byteLength !== 32) {
    throw new Error('SESSION_SECRET_BASE64 must decode to exactly 32 bytes');
  }
  return secret;
};

export const getCognitoConfiguration = (): CognitoConfiguration => {
  const issuer = process.env.COGNITO_ISSUER;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const redirectUri = process.env.COGNITO_REDIRECT_URI;
  const domain = process.env.COGNITO_DOMAIN;
  if (
    issuer === undefined ||
    clientId === undefined ||
    redirectUri === undefined ||
    domain === undefined
  ) {
    throw new Error('Cognito web configuration is incomplete');
  }
  const base = domain.replace(/\/$/, '');
  return {
    issuer,
    clientId,
    redirectUri,
    authorizationEndpoint: `${base}/oauth2/authorize`,
    tokenEndpoint: `${base}/oauth2/token`
  };
};

export interface XeroOAuthConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const getXeroOAuthConfiguration = (): XeroOAuthConfiguration => {
  const clientId = process.env.XERO_OAUTH_CLIENT_ID;
  const clientSecret = process.env.XERO_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.XERO_OAUTH_REDIRECT_URI;
  if (
    clientId === undefined ||
    clientId.trim() === '' ||
    clientSecret === undefined ||
    clientSecret.trim() === '' ||
    redirectUri === undefined ||
    redirectUri.trim() === ''
  ) {
    throw new Error('Xero OAuth configuration is incomplete');
  }
  return { clientId, clientSecret, redirectUri };
};

export const getXeroTokenCipher = (): TokenCipher => {
  const keysJson = process.env.XERO_TOKEN_ENCRYPTION_KEYS_JSON;
  const activeKeyId = process.env.XERO_TOKEN_ACTIVE_KEY_ID;
  if (
    keysJson === undefined ||
    keysJson.trim() === '' ||
    activeKeyId === undefined ||
    activeKeyId.trim() === ''
  ) {
    throw new Error('Xero token encryption configuration is incomplete');
  }
  return AesGcmTokenCipher.fromEnvironment({ keysJson, activeKeyId });
};

export const getStripeConfiguration = (): StripeRuntimeConfiguration => {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const soloPriceId = process.env.STRIPE_SOLO_PRICE_ID?.trim();
  const portalConfigurationId =
    process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (
    !secretKey ||
    !webhookSecret ||
    !soloPriceId ||
    !portalConfigurationId ||
    !publicBaseUrl
  ) {
    throw new Error('Stripe billing configuration is incomplete');
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
  }
  if (
    publicUrl.protocol !== 'https:' ||
    publicUrl.pathname !== '/' ||
    publicUrl.search !== '' ||
    publicUrl.hash !== '' ||
    publicUrl.username !== '' ||
    publicUrl.password !== ''
  ) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
  }
  return {
    secretKey,
    webhookSecret,
    soloPriceId,
    portalConfigurationId,
    publicBaseUrl: publicUrl.origin,
    priceCurrency: 'aud',
    automaticTaxEnabled: true,
    webhookToleranceSeconds: 300
  };
};

export const getSubscriptionService = () => {
  if (subscriptionServicePromise === undefined) {
    const configuration = getStripeConfiguration();
    const clock = { now: () => new Date() };
    subscriptionServicePromise = Promise.resolve(
      createSubscriptionService({
        stripe: createStripeBillingClient(configuration),
        repository: createPostgresSubscriptionRepository(
          getDatabaseClient().db,
          clock
        ),
        soloPriceId: configuration.soloPriceId,
        clock,
        publishLifecycle: async (input) => {
          const queue = await getJobQueue();
          await queue.publish(jobNames.subscriptionLifecycle, input, {
            singletonKey: `${jobNames.subscriptionLifecycle}:${input.organisationId}:${input.status}`,
            deduplicateWhileActive: true
          });
        },
        publishNumberProvision: async (input) => {
          const queue = await getJobQueue();
          await queue.publish(jobNames.smsNumberProvision, input, {
            singletonKey: `${jobNames.smsNumberProvision}:${input.organisationId}`,
            deduplicateWhileActive: true
          });
        }
      })
    );
  }
  return subscriptionServicePromise;
};

export const getOnboardingService = () =>
  createOnboardingService({
    repository: createPostgresOnboardingRepository(getDatabaseClient().db),
    clock: { now: () => new Date() }
  });

export const getSmsCommerceRepository = () =>
  new PostgresSmsCommerceRepository(getDatabaseClient().db);

export const getMobileVerificationService = () => {
  const database = getDatabaseClient().db;
  const hmacSecret = getSessionSecret();
  return createMobileVerificationService({
    repository: createPostgresMobileVerificationRepository(
      database,
      hmacSecret
    ),
    publish: async (organisationId, outboundMessageId) => {
      const queue = await getJobQueue();
      return queue.publish(
        jobNames.testSmsExecute,
        { organisationId, outboundMessageId },
        {
          singletonKey: `verification-otp:${outboundMessageId}`,
          deduplicateWhileActive: true
        }
      );
    },
    clock: { now: () => new Date() },
    codeGenerator: () => randomInt(0, 1_000_000).toString().padStart(6, '0'),
    hmacSecret
  });
};

export const getXeroOAuthService = () => {
  if (xeroOAuthService !== undefined) return xeroOAuthService;
  const database = getDatabaseClient().db;
  const repository = new PostgresXeroConnectionRepository(database);
  const tokenCipher = getXeroTokenCipher();
  const oauth = new XeroOAuthClient({
    http: new FetchHttpClient(),
    ...getXeroOAuthConfiguration()
  });
  const soloProvisioning = createSoloProvisioningService({
    repository: createPostgresSoloProvisioningRepository(database),
    clock: { now: () => new Date() },
    ensureRecurringSchedules: async (organisationId) => {
      const queue = await getJobQueue();
      await ensureRecurringSchedules(queue, [organisationId]);
    },
    publishInitialSync: async (organisationId, singletonKey) => {
      const queue = await getJobQueue();
      await queue.publish(
        jobNames.xeroInitialSync,
        { organisationId },
        { singletonKey, deduplicateWhileActive: true }
      );
    }
  });
  xeroOAuthService = createXeroOAuthService({
    repository,
    tokenCipher,
    oauth,
    sessionForOrganisation: (organisationId) =>
      new XeroOAuthSessionProvider({
        organisationId,
        store: repository,
        tokenCipher,
        oauthClient: oauth
      }).getSession(),
    organisationForTenant: async (accessToken, tenantId) => {
      const result = await new XeroClient({
        http: new FetchHttpClient(),
        sessionProvider: {
          getSession: () => Promise.resolve({ accessToken, tenantId })
        }
      }).getOrganisation();
      return result.data;
    },
    provisionSolo: (session, input) =>
      soloProvisioning.provision(session, input),
    findSoloOrganisation: async (userId) => {
      const [existing] = await database
        .select({ organisationId: organisations.id })
        .from(memberships)
        .innerJoin(
          organisations,
          eq(organisations.id, memberships.organisationId)
        )
        .where(
          and(
            eq(memberships.userId, userId),
            isNull(memberships.disabledAt),
            eq(organisations.edition, 'SOLO')
          )
        )
        .limit(1);
      return existing?.organisationId ?? null;
    },
    audit: async (event) => {
      await database.insert(auditEvents).values({
        organisationId: event.organisationId,
        actorUserId: event.actorUserId,
        eventType: event.eventType,
        entityType: 'XERO_CONNECTION',
        entityId: event.entityId,
        afterValue: event.afterValue,
        occurredAt: event.occurredAt
      });
    },
    clock: { now: () => new Date() }
  });
  return xeroOAuthService;
};

export async function requireWebSession(request: Request): Promise<AppSession> {
  const client = getDatabaseClient();
  return requireSession(request, {
    secret: getSessionSecret(),
    memberships: new PostgresMembershipLoader(client.db)
  });
}

export async function requireWebIdentitySession(
  request: Request
): Promise<AppSession> {
  const client = getDatabaseClient();
  return requireIdentitySession(request, {
    secret: getSessionSecret(),
    memberships: new PostgresMembershipLoader(client.db)
  });
}
