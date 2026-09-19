import { CompactEncrypt, compactDecrypt } from 'jose';

import type { AppSession, SessionMembership } from './authorise.js';

const cookieName = 'bc5000_session';
const sessionLifetimeMilliseconds = 8 * 60 * 60 * 1000;

interface StoredSession {
  version: 1;
  cognitoSubject: string;
  issuedAt: string;
  expiresAt: string;
}

export interface MembershipSnapshot {
  userId: string;
  displayName: string;
  memberships: SessionMembership[];
}

export interface MembershipLoader {
  loadForSubject(subject: string): Promise<MembershipSnapshot | null>;
}

export class AuthenticationFailure extends Error {
  readonly code = 'UNAUTHENTICATED';

  constructor() {
    super('UNAUTHENTICATED');
    this.name = 'AuthenticationFailure';
  }
}

const assertSecret = (secret: Uint8Array): void => {
  if (secret.byteLength !== 32) {
    throw new Error('Session secret must be exactly 32 bytes');
  }
};

const parseCookies = (header: string | null): Map<string, string> => {
  const result = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    result.set(
      part.slice(0, separator).trim(),
      decodeURIComponent(part.slice(separator + 1).trim())
    );
  }
  return result;
};

const sealSession = async (
  session: StoredSession,
  secret: Uint8Array
): Promise<string> => {
  assertSecret(secret);
  return new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(session))
  )
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'JWT' })
    .encrypt(secret);
};

const openSession = async (
  token: string,
  secret: Uint8Array
): Promise<StoredSession> => {
  assertSecret(secret);
  try {
    const { plaintext, protectedHeader } = await compactDecrypt(token, secret);
    if (
      protectedHeader.alg !== 'dir' ||
      protectedHeader.enc !== 'A256GCM'
    ) {
      throw new AuthenticationFailure();
    }
    const value = JSON.parse(
      new TextDecoder().decode(plaintext)
    ) as Partial<StoredSession>;
    if (
      value.version !== 1 ||
      typeof value.cognitoSubject !== 'string' ||
      typeof value.issuedAt !== 'string' ||
      typeof value.expiresAt !== 'string'
    ) {
      throw new AuthenticationFailure();
    }
    return value as StoredSession;
  } catch (error) {
    if (error instanceof AuthenticationFailure) throw error;
    throw new AuthenticationFailure();
  }
};

export async function createSessionCookie(
  input: { cognitoSubject: string },
  options: { secret: Uint8Array; now?: Date }
): Promise<string> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + sessionLifetimeMilliseconds);
  const token = await sealSession(
    {
      version: 1,
      cognitoSubject: input.cognitoSubject,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    },
    options.secret
  );
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=28800; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearSessionCookie = (): string =>
  `${cookieName}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;

export async function requireSession(
  request: Request,
  options: {
    secret: Uint8Array;
    memberships: MembershipLoader;
    now?: Date;
  }
): Promise<AppSession> {
  const token = parseCookies(request.headers.get('cookie')).get(cookieName);
  if (token === undefined) throw new AuthenticationFailure();
  const stored = await openSession(token, options.secret);
  const now = options.now ?? new Date();
  if (
    !Number.isFinite(Date.parse(stored.expiresAt)) ||
    Date.parse(stored.expiresAt) <= now.getTime()
  ) {
    throw new AuthenticationFailure();
  }
  const snapshot = await options.memberships.loadForSubject(
    stored.cognitoSubject
  );
  const activeMemberships =
    snapshot?.memberships.filter((membership) => membership.active) ?? [];
  if (snapshot === null || activeMemberships.length === 0) {
    throw new AuthenticationFailure();
  }
  return {
    userId: snapshot.userId,
    cognitoSubject: stored.cognitoSubject,
    displayName: snapshot.displayName,
    expiresAt: stored.expiresAt,
    memberships: activeMemberships
  };
}
