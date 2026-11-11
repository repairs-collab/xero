import { and, eq, isNull } from 'drizzle-orm';

import {
  AuthorizationFailure,
  type AppSession
} from '@bc5000/auth';
import { users, type PlatformRole } from '@bc5000/db/web';

import {
  getDatabaseClient,
  requireWebIdentitySession
} from './runtime.js';

export interface PlatformAuthorizationDependencies {
  requireIdentitySession(request: Request): Promise<AppSession>;
  loadActivePlatformRole(userId: string): Promise<PlatformRole | null>;
}

export const createPlatformAuthorizer = (
  dependencies: PlatformAuthorizationDependencies
) => ({
  async isPlatformOwner(userId: string): Promise<boolean> {
    return (await dependencies.loadActivePlatformRole(userId)) === 'OWNER';
  },

  async requirePlatformOwner(request: Request): Promise<AppSession> {
    const session = await dependencies.requireIdentitySession(request);
    if ((await dependencies.loadActivePlatformRole(session.userId)) !== 'OWNER') {
      throw new AuthorizationFailure();
    }
    return session;
  }
});

const loadActivePlatformRole = async (
  userId: string
): Promise<PlatformRole | null> => {
  const [user] = await getDatabaseClient()
    .db.select({ platformRole: users.platformRole })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  return user?.platformRole ?? null;
};

const productionAuthorizer = createPlatformAuthorizer({
  requireIdentitySession: requireWebIdentitySession,
  loadActivePlatformRole
});

export const isPlatformOwner = (userId: string): Promise<boolean> =>
  productionAuthorizer.isPlatformOwner(userId);

export const requirePlatformOwner = (
  request: Request
): Promise<AppSession> => productionAuthorizer.requirePlatformOwner(request);
