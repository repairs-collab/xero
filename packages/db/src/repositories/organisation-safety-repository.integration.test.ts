import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { organisations } from '../schema/organisation.js';
import { PostgresOrganisationSafetyRepository } from './organisation-safety-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-29T00:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const seedOrganisation = async () => {
  const organisationId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Safety repository test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  return organisationId;
};

describe('PostgresOrganisationSafetyRepository', () => {
  it('waits for a concurrent maintenance transition and refuses the mutation', async () => {
    const organisationId = await seedOrganisation();
    const repository = new PostgresOrganisationSafetyRepository(client.db);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const maintenanceTransition = client.db.transaction(async (transaction) => {
      await transaction
        .update(organisations)
        .set({ maintenanceMode: true })
        .where(eq(organisations.id, organisationId));
      locked();
      await held;
    });
    await lockAcquired;

    const check = repository.assertOperationalMutationAllowed(
      client.db,
      organisationId
    );
    release();
    await maintenanceTransition;

    await expect(check).rejects.toThrow('OPERATIONAL_MAINTENANCE');
  });

  it('compare-and-sets state and rejects a stale version', async () => {
    const organisationId = await seedOrganisation();
    const repository = new PostgresOrganisationSafetyRepository(client.db);

    await expect(
      repository.compareAndSetOperationalState(client.db, {
        organisationId,
        expectedState: 'READY',
        expectedVersion: 0,
        nextState: 'RESET_PREPARING',
        maintenanceMode: true,
        now
      })
    ).resolves.toMatchObject({
      operationalState: 'RESET_PREPARING',
      operationalStateVersion: 1,
      maintenanceMode: true
    });

    await expect(
      repository.compareAndSetOperationalState(client.db, {
        organisationId,
        expectedState: 'READY',
        expectedVersion: 0,
        nextState: 'RESET_PREPARING',
        maintenanceMode: true,
        now
      })
    ).rejects.toThrow('OPERATIONAL_STATE_CONFLICT');
  });
});
