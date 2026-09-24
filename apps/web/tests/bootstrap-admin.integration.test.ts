import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  auditEvents,
  createDatabase,
  memberships,
  migrateDatabase,
  organisations,
  users
} from '@bc5000/db';

import {
  bootstrapFirstAdmin,
  BootstrapAlreadyCompleted
} from '../src/server/bootstrap-admin.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const now = new Date('2026-09-24T00:00:00.000Z');

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

describe('first administrator bootstrap', () => {
  it('creates a dry-run organisation and its first administrator', async () => {
    const subject = randomUUID();
    const cognito = {
      createUser: vi.fn(() => Promise.resolve({ subject })),
      disableUser: vi.fn(() => Promise.resolve())
    };
    const suffix = randomUUID();

    const result = await bootstrapFirstAdmin(
      { database: client.db, cognito, clock: { now: () => now } },
      {
        email: `  Admin-${suffix}@Example.invalid  `,
        displayName: '  Mott Appliance Repairs Admin  ',
        organisationName: '  Mott Appliance Repairs  ',
        xeroOrganisationId: `pending-${suffix}`,
        timeZone: 'Australia/Sydney',
        baseCurrency: 'AUD'
      }
    );

    expect(result.created).toBe(true);
    expect(cognito.createUser).toHaveBeenCalledWith(
      `admin-${suffix}@example.invalid`
    );
    const [organisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, result.organisationId));
    expect(organisation).toMatchObject({
      name: 'Mott Appliance Repairs',
      sendMode: 'dry-run',
      liveSendAcknowledged: false,
      recipientAllowlist: []
    });
    const [user] = await client.db
      .select()
      .from(users)
      .where(eq(users.id, result.userId));
    expect(user).toMatchObject({
      cognitoSubject: subject,
      email: `admin-${suffix}@example.invalid`,
      displayName: 'Mott Appliance Repairs Admin'
    });
    const [membership] = await client.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organisationId, result.organisationId),
          eq(memberships.userId, result.userId)
        )
      );
    expect(membership).toMatchObject({ role: 'ADMIN', disabledAt: null });
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, result.organisationId));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: result.userId,
          eventType: 'INITIAL_ADMIN_BOOTSTRAPPED'
        })
      ])
    );
  });

  it('is idempotent when the same administrator is bootstrapped again', async () => {
    const suffix = randomUUID();
    const cognito = {
      createUser: vi.fn(() => Promise.resolve({ subject: randomUUID() })),
      disableUser: vi.fn(() => Promise.resolve())
    };
    const input = {
      email: `repeat-${suffix}@example.invalid`,
      displayName: 'Repeat Admin',
      organisationName: 'Repeat Organisation',
      xeroOrganisationId: `pending-${suffix}`,
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    };

    const first = await bootstrapFirstAdmin(
      { database: client.db, cognito, clock: { now: () => now } },
      input
    );
    const second = await bootstrapFirstAdmin(
      { database: client.db, cognito, clock: { now: () => now } },
      input
    );

    expect(second).toEqual({ ...first, created: false });
    expect(cognito.createUser).toHaveBeenCalledOnce();
  });

  it('refuses to add a different bootstrap administrator after setup', async () => {
    const suffix = randomUUID();
    const cognito = {
      createUser: vi.fn(() => Promise.resolve({ subject: randomUUID() })),
      disableUser: vi.fn(() => Promise.resolve())
    };
    const baseInput = {
      displayName: 'Initial Admin',
      organisationName: 'Locked Organisation',
      xeroOrganisationId: `pending-${suffix}`,
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    };
    await bootstrapFirstAdmin(
      { database: client.db, cognito, clock: { now: () => now } },
      { ...baseInput, email: `first-${suffix}@example.invalid` }
    );

    await expect(
      bootstrapFirstAdmin(
        { database: client.db, cognito, clock: { now: () => now } },
        { ...baseInput, email: `second-${suffix}@example.invalid` }
      )
    ).rejects.toThrow(BootstrapAlreadyCompleted);
    expect(cognito.createUser).toHaveBeenCalledOnce();
  });
});
