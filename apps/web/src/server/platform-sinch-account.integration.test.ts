import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';

import { createDatabase, organisations, platformAdminAuditEvents, users } from '@bc5000/db';

import { linkPlatformSinchAccount } from './platform-sinch-account.js';

const client = createDatabase(
  process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
afterAll(() => client.pool.end());

it('limits linking to active platform owners and binds a sub-account to just one company', async () => {
  const [first, second] = await client.db.insert(organisations).values(
    ['First', 'Second'].map((name) => ({
      xeroOrganisationId: randomUUID(), name, timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD', edition: 'SOLO' as const
    }))
  ).returning({ id: organisations.id });
  const [owner, member] = await client.db.insert(users).values(
    ['OWNER', null].map((role) => ({
      cognitoSubject: randomUUID(), displayName: 'Test operator', email: `${randomUUID()}@example.invalid`,
      platformRole: role === 'OWNER' ? 'OWNER' as const : null
    }))
  ).returning({ id: users.id });
  const accountId = `sub_${randomUUID()}`;
  const input = { organisationId: first!.id, accountId, confirmed: true, now: new Date() };

  await expect(linkPlatformSinchAccount(client.db, member!.id, input)).resolves.toBe('NOT_OWNER');
  await expect(linkPlatformSinchAccount(client.db, owner!.id, { ...input, confirmed: false })).resolves.toBe('VALIDATION');
  await expect(linkPlatformSinchAccount(client.db, owner!.id, input)).resolves.toBe('LINKED');
  await expect(linkPlatformSinchAccount(client.db, owner!.id, input)).resolves.toBe('LINKED');
  await expect(linkPlatformSinchAccount(client.db, owner!.id, {
    ...input, organisationId: second!.id
  })).resolves.toBe('ACCOUNT_IN_USE');
  await expect(linkPlatformSinchAccount(client.db, owner!.id, {
    ...input, accountId: `different_${randomUUID()}`
  })).resolves.toBe('ALREADY_LINKED');
  const audits = await client.db.select().from(platformAdminAuditEvents)
    .where(eq(platformAdminAuditEvents.targetOrganisationId, first!.id));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ eventType: 'SINCH_SHARED_ACCOUNT_LINKED', actorUserId: owner!.id });
});
