import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { authorise, type AppSession, type Role } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  invitations,
  memberships,
  users
} from '@bc5000/db/web';

export interface CognitoUserAdministration {
  createUser(email: string): Promise<{ subject: string }>;
  resendInvitation(email: string): Promise<void>;
  disableUser(subject: string): Promise<void>;
}

export class LastAdminRequired extends Error {
  readonly code = 'LAST_ADMIN_REQUIRED';

  constructor() {
    super('LAST_ADMIN_REQUIRED');
    this.name = 'LastAdminRequired';
  }
}

export interface UserAdministrationDependencies {
  database: Database;
  cognito: CognitoUserAdministration;
  clock: { now(): Date };
}

const activeAdminCount = async (
  database: Database,
  organisationId: string
): Promise<number> => {
  const [row] = await database
    .select({ count: sql<number>`count(*)::integer` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organisationId, organisationId),
        eq(memberships.role, 'ADMIN'),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt)
      )
    );
  return row?.count ?? 0;
};

export function createUserAdministration(
  dependencies: UserAdministrationDependencies
) {
  const inviteMember = async (
    session: AppSession,
    input: {
      organisationId: string;
      email: string;
      displayName: string;
      role: Role;
    }
  ): Promise<{ invitationId: string; userId: string }> => {
    authorise(session, 'user.manage', input.organisationId);
    const email = input.email.trim().toLowerCase();
    if (email.length === 0) throw new Error('Email is required');
    const created = await dependencies.cognito.createUser(email);
    const now = dependencies.clock.now();
    const userId = randomUUID();
    const invitationId = randomUUID();
    try {
      await dependencies.database.transaction(async (transaction) => {
        await transaction.insert(users).values({
          id: userId,
          cognitoSubject: created.subject,
          email,
          displayName: input.displayName.trim()
        });
        await transaction.insert(memberships).values({
          organisationId: input.organisationId,
          userId,
          role: input.role
        });
        await transaction.insert(invitations).values({
          id: invitationId,
          organisationId: input.organisationId,
          email,
          role: input.role,
          status: 'PENDING',
          invitedByUserId: session.userId,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        });
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: session.userId,
          eventType: 'USER_INVITED',
          entityType: 'USER',
          entityId: userId,
          afterValue: { email, role: input.role },
          occurredAt: now
        });
      });
    } catch (error) {
      await dependencies.cognito.disableUser(created.subject).catch(() => undefined);
      throw error;
    }
    return { invitationId, userId };
  };

  const resendInvitation = async (
    session: AppSession,
    input: { organisationId: string; invitationId: string }
  ): Promise<void> => {
    authorise(session, 'user.manage', input.organisationId);
    const [invitation] = await dependencies.database
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.organisationId, input.organisationId),
          eq(invitations.id, input.invitationId),
          eq(invitations.status, 'PENDING')
        )
      )
      .limit(1);
    if (invitation === undefined) throw new Error('Invitation was not found');
    await dependencies.cognito.resendInvitation(invitation.email);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .update(invitations)
        .set({ expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) })
        .where(eq(invitations.id, invitation.id));
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'USER_INVITATION_RESENT',
        entityType: 'INVITATION',
        entityId: invitation.id,
        occurredAt: now
      });
    });
  };

  const changeRole = async (
    session: AppSession,
    input: { organisationId: string; userId: string; role: Role }
  ): Promise<void> => {
    authorise(session, 'user.manage', input.organisationId);
    const [membership] = await dependencies.database
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organisationId, input.organisationId),
          eq(memberships.userId, input.userId),
          isNull(memberships.disabledAt)
        )
      )
      .limit(1);
    if (membership === undefined) throw new Error('Membership was not found');
    if (
      membership.role === 'ADMIN' &&
      input.role !== 'ADMIN' &&
      (await activeAdminCount(dependencies.database, input.organisationId)) <= 1
    ) {
      throw new LastAdminRequired();
    }
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .update(memberships)
        .set({ role: input.role })
        .where(
          and(
            eq(memberships.organisationId, input.organisationId),
            eq(memberships.userId, input.userId)
          )
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'USER_ROLE_CHANGED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        beforeValue: { role: membership.role },
        afterValue: { role: input.role },
        occurredAt: now
      });
    });
  };

  const disableMember = async (
    session: AppSession,
    input: { organisationId: string; userId: string }
  ): Promise<void> => {
    authorise(session, 'user.manage', input.organisationId);
    const [row] = await dependencies.database
      .select({ membership: memberships, user: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organisationId, input.organisationId),
          eq(memberships.userId, input.userId),
          isNull(memberships.disabledAt)
        )
      )
      .limit(1);
    if (row === undefined) throw new Error('Membership was not found');
    if (
      row.membership.role === 'ADMIN' &&
      (await activeAdminCount(dependencies.database, input.organisationId)) <= 1
    ) {
      throw new LastAdminRequired();
    }

    await dependencies.cognito.disableUser(row.user.cognitoSubject);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .update(memberships)
        .set({ disabledAt: now })
        .where(
          and(
            eq(memberships.organisationId, input.organisationId),
            eq(memberships.userId, input.userId)
          )
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'USER_DISABLED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        beforeValue: { role: row.membership.role, active: true },
        afterValue: { role: row.membership.role, active: false },
        occurredAt: now
      });
    });
  };

  return {
    inviteMember,
    resendInvitation,
    changeRole,
    disableMember
  };
}
