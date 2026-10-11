import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  type AppSession,
  type CognitoConfiguration,
  requireSession
} from '@bc5000/auth';
import { createDatabase, type DatabaseClient } from '@bc5000/db/web';
import { FetchHttpClient } from '@bc5000/integrations/http';
import { VoiceGatewayClient } from '@bc5000/integrations/voice-gateway';

import { PostgresMembershipLoader } from './membership-loader.js';

let databaseClient: DatabaseClient | undefined;

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

export async function requireWebSession(request: Request): Promise<AppSession> {
  const client = getDatabaseClient();
  return requireSession(request, {
    secret: getSessionSecret(),
    memberships: new PostgresMembershipLoader(client.db)
  });
}
