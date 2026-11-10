import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { authorise, type AppSession, type Role } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  type DbTransaction,
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
  membershipVersion: number;
  invitationVersion: number | null;
}

export class LastAdminRequired extends Error {
  readonly code = 'LAST_ADMIN_REQUIRED';

  constructor() {
    super('LAST_ADMIN_REQUIRED');
    this.name = 'LastAdminRequired';
  }
}

export class UserAdministrationConflict extends Error {
  readonly code = 'CONFLICT';

  constructor() {
    super('CONFLICT');
    this.name = 'UserAdministrationConflict';
  }
}

export interface UserAdministrationMutationAudit {
  eventType:
    | 'USER_INVITED'
    | 'USER_INVITATION_RESENT'
    | 'USER_ROLE_CHANGED'
    | 'USER_DISABLED';
  entityType: 'USER' | 'INVITATION' | 'MEMBERSHIP';
  entityId: string;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
}

export type UserAdministrationAtomicAudit = (
  transaction: DbTransaction,
  audit: UserAdministrationMutationAudit
) => Promise<void>;

export interface UserAdministrationDependencies {
  database: Database;
  cognito: CognitoUserAdministration;
  clock: { now(): Date };
  authorizer?: UserManageAuthorizer;
  reader?: UserManageAuthorizer;
}

export type UserManageAuthorizer = (
  session: AppSession,
  organisationId: string
) => void | Promise<void>;

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
    .set({
      status: 'ACCEPTED',
      acceptedAt: now,
      version: sql`${invitations.version} + 1`
    })
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
  const authorize: UserManageAuthorizer =
    dependencies.authorizer ??
    ((session, organisationId) => {
      authorise(session, 'user.manage', organisationId);
    });
  const authorizeRead: UserManageAuthorizer =
    dependencies.reader ??
    dependencies.authorizer ??
    ((session, organisationId) => {
      authorise(session, 'user.read', organisationId);
    });
  const inviteMember = async (
    session: AppSession,
    input: {
      organisationId: string;
      email: string;
      displayName: string;
      role: Role;
      atomicAudit?: UserAdministrationAtomicAudit;
    }
  ): Promise<{ invitationId: string; userId: string }> => {
    await authorize(session, input.organisationId);
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
        await input.atomicAudit?.(transaction, {
          eventType: 'USER_INVITED',
          entityType: 'USER',
          entityId: userId,
          beforeValue: null,
          afterValue: { email, role: input.role }
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
    await authorizeRead(session, input.organisationId);
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
        invitationId: pendingInvitation?.id ?? null,
        membershipVersion: membership.version,
        invitationVersion: pendingInvitation?.version ?? null
      };
    });
  };

  const resendInvitation = async (
    session: AppSession,
    input: {
      organisationId: string;
      invitationId: string;
      expectedVersion?: number;
      atomicAudit?: UserAdministrationAtomicAudit;
    }
  ): Promise<void> => {
    await authorize(session, input.organisationId);
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
    if (
      input.expectedVersion !== undefined &&
      invitation.version !== input.expectedVersion
    ) {
      throw new UserAdministrationConflict();
    }
    await dependencies.cognito.resendInvitation(invitation.email);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(invitations)
        .set({
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          version: sql`${invitations.version} + 1`
        })
        .where(
          and(
            eq(invitations.id, invitation.id),
            eq(invitations.version, invitation.version)
          )
        )
        .returning({ version: invitations.version });
      if (updated.length !== 1) throw new UserAdministrationConflict();
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'USER_INVITATION_RESENT',
        entityType: 'INVITATION',
        entityId: invitation.id,
        occurredAt: now
      });
      await input.atomicAudit?.(transaction, {
        eventType: 'USER_INVITATION_RESENT',
        entityType: 'INVITATION',
        entityId: invitation.id,
        beforeValue: { version: invitation.version, expiresAt: invitation.expiresAt },
        afterValue: {
          version: invitation.version + 1,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        }
      });
    });
  };

  const changeRole = async (
    session: AppSession,
    input: {
      organisationId: string;
      userId: string;
      role: Role;
      expectedVersion?: number;
      atomicAudit?: UserAdministrationAtomicAudit;
    }
  ): Promise<void> => {
    await authorize(session, input.organisationId);
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
      if (
        input.expectedVersion !== undefined &&
        row.membership.version !== input.expectedVersion
      ) {
        throw new UserAdministrationConflict();
      }
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
        .set({ role: input.role, version: sql`${memberships.version} + 1` })
        .where(
          and(
            eq(memberships.organisationId, input.organisationId),
            eq(memberships.userId, input.userId)
          )
        );
      await transaction
        .update(invitations)
        .set({ role: input.role, version: sql`${invitations.version} + 1` })
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
      await input.atomicAudit?.(transaction, {
        eventType: 'USER_ROLE_CHANGED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        beforeValue: {
          role: row.membership.role,
          version: row.membership.version
        },
        afterValue: {
          role: input.role,
          version: row.membership.version + 1
        }
      });
    });
  };

  const disableMember = async (
    session: AppSession,
    input: {
      organisationId: string;
      userId: string;
      expectedVersion?: number;
      atomicAudit?: UserAdministrationAtomicAudit;
    }
  ): Promise<void> => {
    await authorize(session, input.organisationId);
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
      if (
        input.expectedVersion !== undefined &&
        membership.version !== input.expectedVersion
      ) {
        throw new UserAdministrationConflict();
      }
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
        .set({
          disabledAt: now,
          version: sql`${memberships.version} + 1`
        })
        .where(
          and(
            eq(memberships.organisationId, input.organisationId),
            eq(memberships.userId, input.userId)
          )
        );
      await transaction
        .update(invitations)
        .set({
          status: 'REVOKED',
          version: sql`${invitations.version} + 1`
        })
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
      await input.atomicAudit?.(transaction, {
        eventType: 'USER_DISABLED',
        entityType: 'MEMBERSHIP',
        entityId: input.userId,
        beforeValue: {
          role: membership.role,
          active: true,
          version: membership.version
        },
        afterValue: {
          role: membership.role,
          active: false,
          version: membership.version + 1
        }
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
        disableCognito:
          remainingMembership === undefined && targetUser.platformRole !== 'OWNER'
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
