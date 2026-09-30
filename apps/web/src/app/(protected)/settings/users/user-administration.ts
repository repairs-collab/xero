import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { authorise, type AppSession, type Role } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  invitations,
  memberships,
  organisations,
  users
} from '@bc5000/db/web';

export interface CognitoUserAdministration {
  createUser(email: string): Promise<{ subject: string }>;
  resendInvitation(email: string): Promise<void>;
  disableUser(subject: string): Promise<void>;
}

export type MemberStatus = 'INVITED' | 'ACTIVE' | 'DISABLED';

export interface UserAdministrationMember {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: MemberStatus;
  invitationId: string | null;
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

export async function acceptPendingInvitations(
  database: Database,
  cognitoSubject: string,
  now: Date
): Promise<void> {
  const [user] = await database
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.cognitoSubject, cognitoSubject))
    .limit(1);
  if (user === undefined) return;
  const organisationRows = await database
    .select({ organisationId: memberships.organisationId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (organisationRows.length === 0) return;
  await database
    .update(invitations)
    .set({ status: 'ACCEPTED', acceptedAt: now })
    .where(
      and(
        inArray(
          invitations.organisationId,
          organisationRows.map((row) => row.organisationId)
        ),
        eq(invitations.email, user.email),
        eq(invitations.status, 'PENDING')
      )
    );
}

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
    const [existingUser] = await dependencies.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existingUser !== undefined) throw new Error('USER_EMAIL_EXISTS');
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

  const listMembers = async (
    session: AppSession,
    input: { organisationId: string }
  ): Promise<UserAdministrationMember[]> => {
    authorise(session, 'user.manage', input.organisationId);
    const memberRows = await dependencies.database
      .select({ membership: memberships, user: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organisationId, input.organisationId))
      .orderBy(asc(users.displayName), asc(users.email));
    const invitationRows = await dependencies.database
      .select()
      .from(invitations)
      .where(eq(invitations.organisationId, input.organisationId));
    const pendingByEmail = new Map(
      invitationRows
        .filter((invitation) => invitation.status === 'PENDING')
        .map((invitation) => [invitation.email, invitation] as const)
    );
    return memberRows.map(({ membership, user }) => {
      const pendingInvitation = pendingByEmail.get(user.email);
      const disabled = membership.disabledAt !== null || user.disabledAt !== null;
      return {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: membership.role,
        status: disabled
          ? 'DISABLED'
          : pendingInvitation === undefined
            ? 'ACTIVE'
            : 'INVITED',
        invitationId: pendingInvitation?.id ?? null
      };
    });
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
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .for('update');
      const [row] = await transaction
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
      if (row.membership.role === 'ADMIN' && input.role !== 'ADMIN') {
        const [adminCount] = await transaction
          .select({ count: sql<number>`count(*)::integer` })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.organisationId, input.organisationId),
              eq(memberships.role, 'ADMIN'),
              isNull(memberships.disabledAt),
              isNull(users.disabledAt)
            )
          );
        if ((adminCount?.count ?? 0) <= 1) throw new LastAdminRequired();
      }
      await transaction
        .update(memberships)
        .set({ role: input.role })
        .where(
          and(
            eq(memberships.organisationId, input.organisationId),
            eq(memberships.userId, input.userId)
          )
        );
      await transaction
        .update(invitations)
        .set({ role: input.role })
        .where(
          and(
            eq(invitations.organisationId, input.organisationId),
            eq(invitations.email, row.user.email),
            eq(invitations.status, 'PENDING')
          )
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'USER_ROLE_CHANGED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        beforeValue: { role: row.membership.role },
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
    const now = dependencies.clock.now();
    const disabledIdentity = await dependencies.database.transaction(async (transaction) => {
      await transaction
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .for('update');
      const [targetUser] = await transaction
        .select()
        .from(users)
        .where(eq(users.id, input.userId))
        .for('update')
        .limit(1);
      if (targetUser === undefined) throw new Error('Membership was not found');
      const [membership] = await transaction
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
      if (membership.role === 'ADMIN') {
        const [adminCount] = await transaction
          .select({ count: sql<number>`count(*)::integer` })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.organisationId, input.organisationId),
              eq(memberships.role, 'ADMIN'),
              isNull(memberships.disabledAt),
              isNull(users.disabledAt)
            )
          );
        if ((adminCount?.count ?? 0) <= 1) throw new LastAdminRequired();
      }
      await transaction
        .update(memberships)
        .set({ disabledAt: now })
        .where(
          and(
            eq(memberships.organisationId, input.organisationId),
            eq(memberships.userId, input.userId)
          )
        );
      await transaction
        .update(invitations)
        .set({ status: 'REVOKED' })
        .where(
          and(
            eq(invitations.organisationId, input.organisationId),
            eq(invitations.email, targetUser.email),
            eq(invitations.status, 'PENDING')
          )
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'USER_DISABLED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        beforeValue: { role: membership.role, active: true },
        afterValue: { role: membership.role, active: false },
        occurredAt: now
      });
      const [remainingMembership] = await transaction
        .select({ organisationId: memberships.organisationId })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, input.userId),
            isNull(memberships.disabledAt)
          )
        )
        .limit(1);
      return {
        cognitoSubject: targetUser.cognitoSubject,
        disableCognito: remainingMembership === undefined
      };
    });
    if (disabledIdentity.disableCognito) {
      await dependencies.cognito.disableUser(disabledIdentity.cognitoSubject);
    }
  };

  return {
    listMembers,
    inviteMember,
    resendInvitation,
    changeRole,
    disableMember
  };
}
