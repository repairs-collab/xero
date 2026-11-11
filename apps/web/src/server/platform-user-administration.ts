import { AuthorizationFailure, type AppSession, type Role } from '@bc5000/auth';
import { platformAdminAuditEvents, type Database } from '@bc5000/db/web';

import {
  createUserAdministration,
  type UserAdministrationAtomicAudit
} from '../app/(protected)/settings/users/user-administration.js';
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
  const atomicAudit = (input: {
    session: AppSession;
    organisationId: string;
    eventType: string;
    reason: string;
  }): UserAdministrationAtomicAudit =>
    async (transaction, mutation) => {
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.session.userId,
        targetOrganisationId: input.organisationId,
        eventType: input.eventType,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        reason: reasonText(input.reason),
        beforeValue: mutation.beforeValue,
        afterValue: mutation.afterValue,
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
        role: input.role,
        atomicAudit: atomicAudit({
          session,
          organisationId: input.organisationId,
          eventType: 'PLATFORM_USER_INVITED',
          reason
        })
      };
      const result = await dependencies.shared.inviteMember(session, sharedInput);
      return result;
    },

    async resendInvitation(
      session: AppSession,
      input: {
        organisationId: string;
        invitationId: string;
        expectedVersion: number;
        reason: string;
      }
    ) {
      await assertOwner(session);
      const reason = reasonText(input.reason);
      await dependencies.shared.resendInvitation(session, {
        organisationId: input.organisationId,
        invitationId: input.invitationId,
        expectedVersion: input.expectedVersion,
        atomicAudit: atomicAudit({
          session,
          organisationId: input.organisationId,
          eventType: 'PLATFORM_USER_INVITATION_RESENT',
          reason
        })
      });
    },

    async changeRole(
      session: AppSession,
      input: {
        organisationId: string;
        userId: string;
        role: Role;
        expectedVersion: number;
        reason: string;
      }
    ) {
      await assertOwner(session);
      const reason = reasonText(input.reason);
      await dependencies.shared.changeRole(session, {
        organisationId: input.organisationId,
        userId: input.userId,
        role: input.role,
        expectedVersion: input.expectedVersion,
        atomicAudit: atomicAudit({
          session,
          organisationId: input.organisationId,
          eventType: 'PLATFORM_USER_ROLE_CHANGED',
          reason
        })
      });
    },

    async disableMember(
      session: AppSession,
      input: {
        organisationId: string;
        userId: string;
        expectedVersion: number;
        reason: string;
      }
    ) {
      await assertOwner(session);
      const reason = reasonText(input.reason);
      await dependencies.shared.disableMember(session, {
        organisationId: input.organisationId,
        userId: input.userId,
        expectedVersion: input.expectedVersion,
        atomicAudit: atomicAudit({
          session,
          organisationId: input.organisationId,
          eventType: 'PLATFORM_USER_DISABLED',
          reason
        })
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
  const requireOwner = async (session: AppSession) => {
    if (!(await isPlatformOwner(session.userId))) {
      throw new AuthorizationFailure();
    }
  };
  const shared = createUserAdministration({
    database,
    cognito: createAwsCognitoUserAdministration(),
    clock: { now: () => new Date() },
    authorizer: requireOwner,
    reader: requireOwner
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
