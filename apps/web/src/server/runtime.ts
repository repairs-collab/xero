import {
  type AppSession,
  type CognitoConfiguration,
  requireSession
} from '@bc5000/auth';
import { createDatabase, type DatabaseClient } from '@bc5000/db/web';

import { PostgresMembershipLoader } from './membership-loader.js';

let databaseClient: DatabaseClient | undefined;

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
