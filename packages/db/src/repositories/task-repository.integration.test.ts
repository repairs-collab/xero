import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { contacts, organisations, tasks } from '../schema/index.js';
import { PostgresTaskRepository } from './task-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('PostgresTaskRepository.ensureVoiceContactReview', () => {
  it('creates and refreshes only one open task under concurrent requests', async () => {
    const organisationId = randomUUID();
    const contactId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Task repository test',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(contacts).values({
      id: contactId,
      organisationId,
      xeroContactId: randomUUID(),
      name: 'Phone review customer',
      active: true
    });
    const repository = new PostgresTaskRepository(client.db);
    const now = new Date('2026-10-09T01:00:00.000Z');

    await Promise.all([
      repository.ensureVoiceContactReview({
        organisationId,
        contactId,
        sequenceId: null,
        invoiceId: null,
        summary: 'Add or correct a callable customer phone number',
        now
      }),
      repository.ensureVoiceContactReview({
        organisationId,
        contactId,
        sequenceId: null,
        invoiceId: null,
        summary: 'Add or correct a callable customer phone number',
        now
      })
    ]);
    const rows = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.organisationId, organisationId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'VOICE_CONTACT_REVIEW',
      contactId,
      status: 'OPEN',
      summary: 'Add or correct a callable customer phone number'
    });
  });
});
