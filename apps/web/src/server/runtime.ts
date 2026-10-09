import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  type AppSession,
  type CognitoConfiguration,
  requireSession
} from '@bc5000/auth';
import { createDatabase, type DatabaseClient } from '@bc5000/db/web';

import { PostgresMembershipLoader } from './membership-loader.js';

let databaseClient: DatabaseClient | undefined;

interface VoicePreviewSessionClaims {
  organisationId: string;
  userId: string;
  callFlowHash: string;
  callFlowVersion: number;
  configurationVersion: number;
  agentId: string;
  agentVersion: number;
  voiceId: string;
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
  agentId: string;
  agentVersion: number;
  voiceId: string;
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
  agentId: string;
  agentVersion: number;
  voiceId: string;
}): Promise<{ sessionId: string; passed: boolean }> => {
  const claims = parseVoicePreviewSession(input.previewSessionToken);
  if (
    claims.expiresAt < Date.now() ||
    claims.organisationId !== input.organisationId ||
    claims.userId !== input.userId ||
    claims.callFlowHash !== input.callFlowHash ||
    claims.callFlowVersion !== input.callFlowVersion ||
    claims.configurationVersion !== input.configurationVersion ||
    claims.agentId !== input.agentId ||
    claims.agentVersion !== input.agentVersion ||
    claims.voiceId !== input.voiceId
  ) {
    throw new Error('VOICE_PREVIEW_SESSION_INVALID');
  }
  return Promise.resolve({ sessionId: claims.sessionId, passed: true });
};

const resolveManagedSecret = (reference: string): string => {
  const environmentName = reference.replace(/^env:/, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
    throw new Error('VOICE_SECRET_REFERENCE_UNSUPPORTED');
  }
  const value = process.env[environmentName];
  if (value === undefined || value.trim() === '') {
    throw new Error('VOICE_SECRET_NOT_AVAILABLE');
  }
  return value;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const getVoiceProviderTester = () => ({
  test: async (input: {
    secretReference: string;
    previewPublicKey: string;
    agentId: string;
    agentVersion: number;
    voiceId: string;
  }) => {
    const apiKey = resolveManagedSecret(input.secretReference);
    const baseUrl = (
      process.env.RETELL_API_BASE_URL ?? 'https://api.retellai.com'
    ).replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/get-agent/${encodeURIComponent(input.agentId)}?version=${input.agentVersion}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(10_000)
        }
      );
    } catch {
      return {
        authenticated: false,
        agentVersionAvailable: false,
        voiceAvailable: false,
        previewKeyDomainRestricted: false,
        recaptchaProtection: 'disabled' as const,
        recordingDisabled: false
      };
    }
    const authenticated = response.status !== 401 && response.status !== 403;
    const body = response.ok
      ? asRecord(await response.json().catch(() => null))
      : null;
    const allowedOrigins = (process.env.VOICE_PREVIEW_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const previewKeyDomainRestricted =
      input.previewPublicKey.startsWith('public_key_') &&
      allowedOrigins.length > 0 &&
      !allowedOrigins.includes('*');
    const configuredRecaptcha = process.env.VOICE_PREVIEW_RECAPTCHA_MODE;
    const recaptchaProtection =
      configuredRecaptcha === 'unsupported'
        ? 'unsupported' as const
        : configuredRecaptcha === 'enabled'
          ? 'enabled' as const
          : 'disabled' as const;
    return {
      authenticated,
      agentVersionAvailable:
        response.ok && body?.version === input.agentVersion,
      voiceAvailable: response.ok && body?.voice_id === input.voiceId,
      previewKeyDomainRestricted,
      recaptchaProtection,
      recordingDisabled:
        process.env.VOICE_PREVIEW_RECORDING_DISABLED === 'true'
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
