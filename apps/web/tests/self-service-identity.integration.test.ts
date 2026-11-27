import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, users } from '@bc5000/db';

import {
  ensureSelfServiceIdentity,
  SelfServiceIdentityConflict,
  SelfServiceSignupClosed
} from '../src/server/self-service-identity.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

describe('self-service Cognito identity persistence', () => {
  it('creates a provisional user while open and lets the existing identity sign in while closed', async () => {
    const subject = randomUUID();
    const email = `owner-${randomUUID()}@example.invalid`;

    const created = await ensureSelfServiceIdentity(client.db, {
      subject,
      email: email.toUpperCase(),
      name: 'First Name'
    }, { allowCreate: true });
    const updated = await ensureSelfServiceIdentity(client.db, {
      subject,
      email,
      name: 'Updated Name'
    }, { allowCreate: false });

    expect(created.created).toBe(true);
    expect(updated).toEqual({ userId: created.userId, created: false });
    const [stored] = await client.db
      .select()
      .from(users)
      .where(eq(users.id, created.userId));
    expect(stored).toMatchObject({
      cognitoSubject: subject,
      email,
      displayName: 'Updated Name'
    });
  });

  it('cannot create an unknown Cognito subject while signup is closed', async () => {
    const subject = randomUUID();
    await expect(ensureSelfServiceIdentity(client.db, {
      subject,
      email: `new-${randomUUID()}@example.invalid`
    }, { allowCreate: false })).rejects.toThrow(SelfServiceSignupClosed);

    const stored = await client.db.select().from(users).where(eq(users.cognitoSubject, subject));
    expect(stored).toHaveLength(0);
  });

  it('never links a different Cognito subject by matching email', async () => {
    const email = `conflict-${randomUUID()}@example.invalid`;
    const firstSubject = randomUUID();
    const secondSubject = randomUUID();
    await ensureSelfServiceIdentity(client.db, {
      subject: firstSubject,
      email,
      name: 'First Owner'
    }, { allowCreate: true });

    await expect(
      ensureSelfServiceIdentity(client.db, {
        subject: secondSubject,
        email: email.toUpperCase(),
        name: 'Second Owner'
      }, { allowCreate: true })
    ).rejects.toThrow(SelfServiceIdentityConflict);

    const matching = await client.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    expect(matching).toHaveLength(1);
    expect(matching[0]?.cognitoSubject).toBe(firstSubject);
  });
});
