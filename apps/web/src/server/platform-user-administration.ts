import { AuthorizationFailure, type AppSession, type Role } from '@bc5000/auth';
import { platformAdminAuditEvents, type Database } from '@bc5000/db/web';

import { createUserAdministration } from '../app/(protected)/settings/users/user-administration.js';
import { createAwsCognitoUserAdministration } from './cognito-admin.js';
import { isPlatformOwner } from './platform-authorization.js';
import { getDatabaseClient } from './runtime.js';

type SharedUserAdministration = ReturnType<typeof createUserAdministration>;

export interface PlatformUserAdministrationDependencies {
  verifyOwner(userId: string): Promise<boolean>;
  shared: SharedUserAdministration;
  database: Database;
  clock: { now(): Date };
}

const reasonText = (reason: string): string => {
  const value = reason.trim();
  if (value.length === 0 || value.length > 500) {
    throw new Error('VALIDATION');
  }
  return value;
};

export const createPlatformUserAdministration = (
  dependencies: PlatformUserAdministrationDependencies
) => {
  const assertOwner = async (session: AppSession) => {
    if (!(await dependencies.verifyOwner(session.userId))) {
      throw new AuthorizationFailure();
    }
  };
  const audit = async (input: {
    session: AppSession;
    organisationId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    reason: string;
    afterValue?: Record<string, unknown>;
  }) => {
    await dependencies.database.insert(platformAdminAuditEvents).values({
      actorUserId: input.session.userId,
      targetOrganisationId: input.organisationId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      reason: reasonText(input.reason),
      afterValue: input.afterValue ?? null,
      occurredAt: dependencies.clock.now()
    });
  };

  return {
    async listMembers(
      session: AppSession,
      input: { organisationId: string }
    ) {
      await assertOwner(session);
      return dependencies.shared.listMembers(session, input);
    },

    async inviteMember(
      session: AppSession,
      input: {
        organisationId: string;
        email: string;
        displayName: string;
        role: Role;
        reason: string;
      }
    ) {
      await assertOwner(session);
      const reason = reasonText(input.reason);
      const sharedInput = {
        organisationId: input.organisationId,
        email: input.email,
        displayName: input.displayName,
        role: input.role
      };
      const result = await dependencies.shared.inviteMember(session, sharedInput);
      await audit({
        session,
        organisationId: input.organisationId,
        eventType: 'PLATFORM_USER_INVITED',
        entityType: 'USER',
        entityId: result.userId,
        reason,
        afterValue: { role: input.role }
      });
      return result;
    },

    async resendInvitation(
      session: AppSession,
      input: { organisationId: string; invitationId: string; reason: string }
    ) {
      await assertOwner(session);
      const reason = reasonText(input.reason);
      await dependencies.shared.resendInvitation(session, {
        organisationId: input.organisationId,
        invitationId: input.invitationId
      });
      await audit({
        session,
        organisationId: input.organisationId,
        eventType: 'PLATFORM_USER_INVITATION_RESENT',
        entityType: 'INVITATION',
        entityId: input.invitationId,
        reason
      });
    },

    async changeRole(
      session: AppSession,
      input: {
        organisationId: string;
        userId: string;
        role: Role;
        reason: string;
      }
    ) {
      await assertOwner(session);
      const reason = reasonText(input.reason);
      await dependencies.shared.changeRole(session, {
        organisationId: input.organisationId,
        userId: input.userId,
        role: input.role
      });
      await audit({
        session,
        organisationId: input.organisationId,
        eventType: 'PLATFORM_USER_ROLE_CHANGED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        reason,
        afterValue: { role: input.role }
      });
    },

    async disableMember(
      session: AppSession,
      input: { organisationId: string; userId: string; reason: string }
    ) {
      await assertOwner(session);
      const reason = reasonText(input.reason);
      await dependencies.shared.disableMember(session, {
        organisationId: input.organisationId,
        userId: input.userId
      });
      await audit({
        session,
        organisationId: input.organisationId,
        eventType: 'PLATFORM_USER_DISABLED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        reason,
        afterValue: { active: false }
      });
    }
  };
};

type PlatformUserAdministration = ReturnType<
  typeof createPlatformUserAdministration
>;

let service: PlatformUserAdministration | undefined;

const buildPlatformUserAdministration = (): PlatformUserAdministration => {
  if (service) return service;
  const database = getDatabaseClient().db;
  const shared = createUserAdministration({
    database,
    cognito: createAwsCognitoUserAdministration(),
    clock: { now: () => new Date() },
    authorizer: async (session) => {
      if (!(await isPlatformOwner(session.userId))) {
        throw new AuthorizationFailure();
      }
    }
  });
  service = createPlatformUserAdministration({
    verifyOwner: isPlatformOwner,
    shared,
    database,
    clock: { now: () => new Date() }
  });
  return service;
};

const lazyService: PlatformUserAdministration = {
  listMembers: (...args) => buildPlatformUserAdministration().listMembers(...args),
  inviteMember: (...args) => buildPlatformUserAdministration().inviteMember(...args),
  resendInvitation: (...args) =>
    buildPlatformUserAdministration().resendInvitation(...args),
  changeRole: (...args) => buildPlatformUserAdministration().changeRole(...args),
  disableMember: (...args) =>
    buildPlatformUserAdministration().disableMember(...args)
};

export const getPlatformUserAdministration = (): PlatformUserAdministration =>
  lazyService;
