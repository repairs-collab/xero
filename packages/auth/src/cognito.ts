import { createHash, randomBytes } from 'node:crypto';

import {
  CompactEncrypt,
  compactDecrypt,
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey
} from 'jose';

export interface CognitoConfiguration {
  issuer: string;
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface CognitoLoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: string;
  returnTo?: string;
}

export interface CognitoAuthorizationRequest {
  url: string;
  transaction: CognitoLoginTransaction;
}

export class CognitoAuthenticationFailure extends Error {
  constructor(message = 'COGNITO_AUTHENTICATION_FAILED') {
    super(message);
    this.name = 'CognitoAuthenticationFailure';
  }
}

const transactionCookieName = 'bc5000_login';

const transactionToken = async (
  transaction: CognitoLoginTransaction,
  secret: Uint8Array
): Promise<string> => {
  if (secret.byteLength !== 32) throw new Error('Session secret must be 32 bytes');
  return new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(transaction))
  )
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(secret);
};

export async function createCognitoTransactionCookie(
  transaction: CognitoLoginTransaction,
  secret: Uint8Array
): Promise<string> {
  const token = await transactionToken(transaction, secret);
  return `${transactionCookieName}=${encodeURIComponent(token)}; Path=/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export const clearCognitoTransactionCookie = (): string =>
  `${transactionCookieName}=; Path=/auth; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;

export async function readCognitoTransaction(
  request: Request,
  secret: Uint8Array
): Promise<CognitoLoginTransaction> {
  if (secret.byteLength !== 32) throw new Error('Session secret must be 32 bytes');
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${transactionCookieName}=`));
  if (cookie === undefined) throw new CognitoAuthenticationFailure();
  try {
    const token = decodeURIComponent(cookie.slice(transactionCookieName.length + 1));
    const { plaintext } = await compactDecrypt(token, secret);
    const value = JSON.parse(
      new TextDecoder().decode(plaintext)
    ) as Partial<CognitoLoginTransaction>;
    if (
      typeof value.state !== 'string' ||
      typeof value.nonce !== 'string' ||
      typeof value.codeVerifier !== 'string' ||
      typeof value.expiresAt !== 'string'
    ) {
      throw new CognitoAuthenticationFailure();
    }
    if (value.returnTo !== undefined && typeof value.returnTo !== 'string') {
      throw new CognitoAuthenticationFailure();
    }
    return value as CognitoLoginTransaction;
  } catch (error) {
    if (error instanceof CognitoAuthenticationFailure) throw error;
    throw new CognitoAuthenticationFailure();
  }
}

const randomBase64Url = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url');

export function createCognitoAuthorizationRequest(
  configuration: CognitoConfiguration,
  options: { now?: Date; returnTo?: string } = {}
): CognitoAuthorizationRequest {
  const now = options.now ?? new Date();
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const codeVerifier = randomBase64Url();
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  const url = new URL(configuration.authorizationEndpoint);
  url.searchParams.set('client_id', configuration.clientId);
  url.searchParams.set('redirect_uri', configuration.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return {
    url: url.toString(),
    transaction: {
      state,
      nonce,
      codeVerifier,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      ...(options.returnTo === undefined ? {} : { returnTo: options.returnTo })
    }
  };
}

export async function exchangeCognitoCode(
  input: {
    code: string;
    returnedState: string;
    transaction: CognitoLoginTransaction;
  },
  configuration: CognitoConfiguration,
  options: {
    fetcher?: typeof fetch;
    jwks?: JWTVerifyGetKey;
    now?: Date;
  } = {}
): Promise<{ subject: string }> {
  const now = options.now ?? new Date();
  if (
    input.returnedState !== input.transaction.state ||
    Date.parse(input.transaction.expiresAt) <= now.getTime()
  ) {
    throw new CognitoAuthenticationFailure();
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: configuration.clientId,
    code: input.code,
    redirect_uri: configuration.redirectUri,
    code_verifier: input.transaction.codeVerifier
  });
  const response = await (options.fetcher ?? fetch)(
    configuration.tokenEndpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    }
  );
  if (!response.ok) throw new CognitoAuthenticationFailure();
  const tokenResponse = (await response.json()) as {
    id_token?: unknown;
  };
  if (typeof tokenResponse.id_token !== 'string') {
    throw new CognitoAuthenticationFailure();
  }

  try {
    const jwks =
      options.jwks ??
      createRemoteJWKSet(
        new URL(
          `${configuration.issuer.replace(/\/$/, '')}/.well-known/jwks.json`
        )
      );
    const verified = await jwtVerify(tokenResponse.id_token, jwks, {
      issuer: configuration.issuer,
      audience: configuration.clientId,
      currentDate: now
    });
    if (
      verified.payload.nonce !== input.transaction.nonce ||
      typeof verified.payload.sub !== 'string'
    ) {
      throw new CognitoAuthenticationFailure();
    }
    return { subject: verified.payload.sub };
  } catch (error) {
    if (error instanceof CognitoAuthenticationFailure) throw error;
    throw new CognitoAuthenticationFailure();
  }
}
