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
    expect(cognito.disableUser).toHaveBeenCalledOnce();
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
  });
});
