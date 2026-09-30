import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  auditEvents,
  createDatabase,
  invitations,
  memberships,
  migrateDatabase,
  organisations,
  users
} from '@bc5000/db';

import {
  acceptPendingInvitations,
  createUserAdministration,
  LastAdminRequired
} from '../src/app/(protected)/settings/users/user-administration.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const now = new Date('2026-09-18T00:00:00.000Z');

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

const seedAdmin = async () => {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const cognitoSubject = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    name: 'User Admin Test Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject,
    email: `admin-${userId}@example.invalid`,
    displayName: 'Admin User'
  });
  await client.db.insert(memberships).values({
    organisationId,
    userId,
    role: 'ADMIN'
  });
  const session: AppSession = {
    userId,
    cognitoSubject,
    displayName: 'Admin User',
    expiresAt: '2026-09-18T08:00:00.000Z',
    memberships: [{ organisationId, role: 'ADMIN', active: true }]
  };
  return { organisationId, userId, cognitoSubject, session };
};

describe('user administration', () => {
  it('invites a user and records membership and audit state', async () => {
    const seeded = await seedAdmin();
    const newSubject = randomUUID();
    const cognito = {
      createUser: vi.fn(() => Promise.resolve({ subject: newSubject })),
      resendInvitation: vi.fn(() => Promise.resolve()),
      disableUser: vi.fn(() => Promise.resolve())
    };
    const service = createUserAdministration({
      database: client.db,
      cognito,
      clock: { now: () => now }
    });
    const email = `operator-${seeded.userId}@example.invalid`;

    const invited = await service.inviteMember(seeded.session, {
      organisationId: seeded.organisationId,
      email,
      displayName: 'New Operator',
      role: 'OPERATOR'
    });

    expect(cognito.createUser).toHaveBeenCalledWith(email);
    const [invitation] = await client.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, invited.invitationId));
    expect(invitation?.status).toBe('PENDING');
    const [membership] = await client.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organisationId, seeded.organisationId),
          eq(memberships.userId, invited.userId)
        )
      );
    expect(membership?.role).toBe('OPERATOR');
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(events.map((event) => event.eventType)).toContain('USER_INVITED');

    const members = await service.listMembers(seeded.session, {
      organisationId: seeded.organisationId
    });
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: invited.userId,
          email,
          displayName: 'New Operator',
          role: 'OPERATOR',
          status: 'INVITED',
          invitationId: invited.invitationId
        }),
        expect.objectContaining({
          userId: seeded.userId,
          role: 'ADMIN',
          status: 'ACTIVE'
        })
      ])
    );
  });

  it('rejects a duplicate email before creating another Cognito user', async () => {
    const seeded = await seedAdmin();
    const cognito = {
      createUser: vi.fn(() => Promise.resolve({ subject: randomUUID() })),
      resendInvitation: vi.fn(() => Promise.resolve()),
      disableUser: vi.fn(() => Promise.resolve())
    };
    const service = createUserAdministration({
      database: client.db,
      cognito,
      clock: { now: () => now }
    });
    const [admin] = await client.db
      .select()
      .from(users)
      .where(eq(users.id, seeded.userId));

    await expect(
      service.inviteMember(seeded.session, {
        organisationId: seeded.organisationId,
        email: admin!.email.toUpperCase(),
        displayName: 'Duplicate',
        role: 'OPERATOR'
      })
    ).rejects.toThrow('USER_EMAIL_EXISTS');
    expect(cognito.createUser).not.toHaveBeenCalled();
  });

  it('refuses to disable the last active Admin', async () => {
    const seeded = await seedAdmin();
    const service = createUserAdministration({
      database: client.db,
      cognito: {
        createUser: vi.fn(),
        resendInvitation: vi.fn(),
        disableUser: vi.fn()
      },
      clock: { now: () => now }
    });

    await expect(
      service.disableMember(seeded.session, {
        organisationId: seeded.organisationId,
        userId: seeded.userId
      })
    ).rejects.toThrow(LastAdminRequired);
  });

  it('prevents an Operator from administering users', async () => {
    const seeded = await seedAdmin();
    const service = createUserAdministration({
      database: client.db,
      cognito: {
        createUser: vi.fn(),
        resendInvitation: vi.fn(),
        disableUser: vi.fn()
      },
      clock: { now: () => now }
    });
    const operatorSession: AppSession = {
      ...seeded.session,
      memberships: [
        {
          organisationId: seeded.organisationId,
          role: 'OPERATOR',
          active: true
        }
      ]
    };

    await expect(
      service.inviteMember(operatorSession, {
        organisationId: seeded.organisationId,
        email: 'blocked@example.invalid',
        displayName: 'Blocked User',
        role: 'OPERATOR'
      })
    ).rejects.toThrow('FORBIDDEN');
  });

  it('resends, changes role, and disables a member while retaining an Admin', async () => {
    const seeded = await seedAdmin();
    const invitedSubject = randomUUID();
    const cognito = {
      createUser: vi.fn(() => Promise.resolve({ subject: invitedSubject })),
      resendInvitation: vi.fn(() => Promise.resolve()),
      disableUser: vi.fn(() => Promise.resolve())
    };
    const service = createUserAdministration({
      database: client.db,
      cognito,
      clock: { now: () => now }
    });
    const email = `managed-${seeded.userId}@example.invalid`;
    const invited = await service.inviteMember(seeded.session, {
      organisationId: seeded.organisationId,
      email,
      displayName: 'Managed User',
      role: 'OPERATOR'
    });

    await service.resendInvitation(seeded.session, {
      organisationId: seeded.organisationId,
      invitationId: invited.invitationId
    });
    await service.changeRole(seeded.session, {
      organisationId: seeded.organisationId,
      userId: invited.userId,
      role: 'ADMIN'
    });
    await service.disableMember(seeded.session, {
      organisationId: seeded.organisationId,
      userId: invited.userId
    });

    expect(cognito.resendInvitation).toHaveBeenCalledWith(email);
    expect(cognito.disableUser).toHaveBeenCalledWith(invitedSubject);
    const [membership] = await client.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organisationId, seeded.organisationId),
          eq(memberships.userId, invited.userId)
        )
      );
    expect(membership).toMatchObject({ role: 'ADMIN' });
    expect(membership?.disabledAt).toEqual(now);
    const [invitation] = await client.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, invited.invitationId));
    expect(invitation).toMatchObject({ role: 'ADMIN', status: 'REVOKED' });

    const members = await service.listMembers(seeded.session, {
      organisationId: seeded.organisationId
    });
    expect(members).toContainEqual(
      expect.objectContaining({
        userId: invited.userId,
        status: 'DISABLED'
      })
    );
  });

  it('marks a pending invitation accepted on the invited user first login', async () => {
    const seeded = await seedAdmin();
    const subject = randomUUID();
    const email = `first-login-${seeded.userId}@example.invalid`;
    const service = createUserAdministration({
      database: client.db,
      cognito: {
        createUser: vi.fn(() => Promise.resolve({ subject })),
        resendInvitation: vi.fn(() => Promise.resolve()),
        disableUser: vi.fn(() => Promise.resolve())
      },
      clock: { now: () => now }
    });
    const invited = await service.inviteMember(seeded.session, {
      organisationId: seeded.organisationId,
      email,
      displayName: 'First Login User',
      role: 'OPERATOR'
    });

    await acceptPendingInvitations(client.db, subject, now);

    const [invitation] = await client.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, invited.invitationId));
    expect(invitation).toMatchObject({
      status: 'ACCEPTED',
      acceptedAt: now
    });
  });

  it('serializes concurrent Admin demotions so one active Admin remains', async () => {
    const first = await seedAdmin();
    const secondUserId = randomUUID();
    const secondSubject = randomUUID();
    await client.db.insert(users).values({
      id: secondUserId,
      cognitoSubject: secondSubject,
      email: `second-admin-${secondUserId}@example.invalid`,
      displayName: 'Second Admin'
    });
    await client.db.insert(memberships).values({
      organisationId: first.organisationId,
      userId: secondUserId,
      role: 'ADMIN'
    });
    const secondSession: AppSession = {
      userId: secondUserId,
      cognitoSubject: secondSubject,
      displayName: 'Second Admin',
      expiresAt: first.session.expiresAt,
      memberships: [
        { organisationId: first.organisationId, role: 'ADMIN', active: true }
      ]
    };
    const service = createUserAdministration({
      database: client.db,
      cognito: {
        createUser: vi.fn(),
        resendInvitation: vi.fn(),
        disableUser: vi.fn()
      },
      clock: { now: () => now }
    });

    const results = await Promise.allSettled([
      service.changeRole(first.session, {
        organisationId: first.organisationId,
        userId: secondUserId,
        role: 'OPERATOR'
      }),
      service.changeRole(secondSession, {
        organisationId: first.organisationId,
        userId: first.userId,
        role: 'OPERATOR'
      })
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const memberRows = await client.db
      .select()
      .from(memberships)
      .where(eq(memberships.organisationId, first.organisationId));
    expect(
      memberRows.filter(
        (membership) =>
          membership.role === 'ADMIN' && membership.disabledAt === null
      )
    ).toHaveLength(1);
  });

  it('serializes concurrent Admin disables so one active Admin remains', async () => {
    const first = await seedAdmin();
    const secondUserId = randomUUID();
    const secondSubject = randomUUID();
    await client.db.insert(users).values({
      id: secondUserId,
      cognitoSubject: secondSubject,
      email: `second-disable-${secondUserId}@example.invalid`,
      displayName: 'Second Disable Admin'
    });
    await client.db.insert(memberships).values({
      organisationId: first.organisationId,
      userId: secondUserId,
      role: 'ADMIN'
    });
    const secondSession: AppSession = {
      userId: secondUserId,
      cognitoSubject: secondSubject,
      displayName: 'Second Disable Admin',
      expiresAt: first.session.expiresAt,
      memberships: [
        { organisationId: first.organisationId, role: 'ADMIN', active: true }
      ]
    };
    const service = createUserAdministration({
      database: client.db,
      cognito: {
        createUser: vi.fn(),
        resendInvitation: vi.fn(),
        disableUser: vi.fn(() => Promise.resolve())
      },
      clock: { now: () => now }
    });

    const results = await Promise.allSettled([
      service.disableMember(first.session, {
        organisationId: first.organisationId,
        userId: secondUserId
      }),
      service.disableMember(secondSession, {
        organisationId: first.organisationId,
        userId: first.userId
      })
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const memberRows = await client.db
      .select()
      .from(memberships)
      .where(eq(memberships.organisationId, first.organisationId));
    expect(
      memberRows.filter(
        (membership) =>
          membership.role === 'ADMIN' && membership.disabledAt === null
      )
    ).toHaveLength(1);
  });

  it('keeps Cognito enabled when the user still belongs to another organisation', async () => {
    const admin = await seedAdmin();
    const secondOrganisationId = randomUUID();
    const targetUserId = randomUUID();
    const targetSubject = randomUUID();
    await client.db.insert(organisations).values({
      id: secondOrganisationId,
      name: 'Second Organisation',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(users).values({
      id: targetUserId,
      cognitoSubject: targetSubject,
      email: `multi-org-${targetUserId}@example.invalid`,
      displayName: 'Multi Organisation User'
    });
    await client.db.insert(memberships).values([
      {
        organisationId: admin.organisationId,
        userId: targetUserId,
        role: 'OPERATOR'
      },
      {
        organisationId: secondOrganisationId,
        userId: targetUserId,
        role: 'OPERATOR'
      }
    ]);
    const cognito = {
      createUser: vi.fn(),
      resendInvitation: vi.fn(),
      disableUser: vi.fn(() => Promise.resolve())
    };
    const service = createUserAdministration({
      database: client.db,
      cognito,
      clock: { now: () => now }
    });

    await service.disableMember(admin.session, {
      organisationId: admin.organisationId,
      userId: targetUserId
    });

    expect(cognito.disableUser).not.toHaveBeenCalled();
    const memberRows = await client.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, targetUserId));
    expect(
      memberRows.find(
        (membership) => membership.organisationId === admin.organisationId
      )?.disabledAt
    ).toEqual(now);
    expect(
      memberRows.find(
        (membership) => membership.organisationId === secondOrganisationId
      )?.disabledAt
    ).toBeNull();
  });
});
