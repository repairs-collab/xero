import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { debtContactClaims } from '../schema/debt-contact.js';
import { contacts, organisations } from '../schema/index.js';
import { PostgresDebtContactRepository } from './debt-contact-repository.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

const seedContact = async (label: string) => {
  const organisationId = randomUUID();
  const contactId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: label,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: `${label} customer`,
    active: true
  });
  return { organisationId, contactId };
};

describe('PostgresDebtContactRepository', () => {
  it('atomically grants one cross-channel claim per tenant customer and local day', async () => {
    const seeded = await seedContact('Concurrent debt contact');
    const repository = new PostgresDebtContactRepository(client.db);
    const claimedAt = new Date('2026-10-07T22:30:00.000Z');

    const outcomes = await Promise.all([
      repository.claimDebtContact({
        ...seeded,
        localDate: '2026-10-08',
        channel: 'SMS',
        sourceId: randomUUID(),
        claimedAt
      }),
      repository.claimDebtContact({
        ...seeded,
        localDate: '2026-10-08',
        channel: 'VOICE',
        sourceId: randomUUID(),
        claimedAt
      })
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      'already-claimed',
      'claimed'
    ]);
    const rows = await client.db
      .select()
      .from(debtContactClaims)
      .where(
        and(
          eq(debtContactClaims.organisationId, seeded.organisationId),
          eq(debtContactClaims.contactId, seeded.contactId),
          eq(debtContactClaims.localDate, '2026-10-08')
        )
      );
    expect(rows).toHaveLength(1);
    expect(['SMS', 'VOICE']).toContain(rows[0]?.channel);
  });

  it('allows the same customer on a later Sydney local day', async () => {
    const seeded = await seedContact('Next-day debt contact');
    const repository = new PostgresDebtContactRepository(client.db);

    await expect(
      repository.claimDebtContact({
        ...seeded,
        localDate: '2026-10-08',
        channel: 'SMS',
        sourceId: randomUUID(),
        claimedAt: new Date('2026-10-07T22:30:00.000Z')
      })
    ).resolves.toMatchObject({ kind: 'claimed' });
    await expect(
      repository.claimDebtContact({
        ...seeded,
        localDate: '2026-10-09',
        channel: 'VOICE',
        sourceId: randomUUID(),
        claimedAt: new Date('2026-10-08T22:30:00.000Z')
      })
    ).resolves.toMatchObject({ kind: 'claimed' });
  });
});
