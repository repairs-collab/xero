import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  auditEvents,
  contacts,
  invoiceChases,
  invoices,
  organisations,
  outboundMessages,
  reminderSequenceVersions,
  reminderSequences,
  stageInstances
} from './index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const database = createDatabase(databaseUrl);

beforeAll(async () => {
  await migrateDatabase(database.db);
});

afterAll(async () => {
  await database.pool.end();
});

const seedStageInstance = async () => {
  const organisationId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const chaseId = randomUUID();
  const stageInstanceId = randomUUID();

  await database.db.insert(organisations).values({
    id: organisationId,
    name: 'Test Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await database.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Test Customer',
    active: true
  });
  await database.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '100.0000',
    currency: 'AUD',
    syncVersion: 1
  });
  await database.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: 'Starter sequence',
    mode: 'REVIEW'
  });
  await database.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {}
  });
  await database.db.insert(invoiceChases).values({
    id: chaseId,
    organisationId,
    invoiceId,
    sequenceId,
    status: 'ACTIVE'
  });
  await database.db.insert(stageInstances).values({
    id: stageInstanceId,
    organisationId,
    invoiceChaseId: chaseId,
    sequenceVersionId,
    stageKey: 'due-date',
    channel: 'SMS',
    status: 'DUE',
    scheduledAt: new Date('2026-09-18T00:00:00Z'),
    sourceVersion: 1
  });

  return { organisationId, stageInstanceId };
};

describe('database invariants', () => {
  it('prevents two outbound rows with the same organisation idempotency key', async () => {
    const { organisationId, stageInstanceId } = await seedStageInstance();
    const idempotencyKey = `${organisationId}:due-date:sms:+61400000000:v1`;
    const value = {
      organisationId,
      stageInstanceId,
      channel: 'SMS' as const,
      recipientKey: '+61400000000',
      sourceVersion: 1,
      contentHash: 'sha256:test',
      status: 'PENDING' as const,
      idempotencyKey
    };

    await database.db.insert(outboundMessages).values(value);
    await expect(
      database.db.insert(outboundMessages).values(value)
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('requires organisation ownership on customer records', async () => {
    await expect(
      database.pool.query(
        'insert into contacts (id, organisation_id, xero_contact_id, name, active) values ($1, $2, $3, $4, $5)',
        [randomUUID(), null, randomUUID(), 'No owner', true]
      )
    ).rejects.toMatchObject({ code: '23502' });
  });

  it.each(['update', 'delete'] as const)(
    'prevents %s operations on append-only audit events',
    async (operation) => {
      const { organisationId } = await seedStageInstance();
      const inserted = await database.db
        .insert(auditEvents)
        .values({
          organisationId,
          eventType: 'TEST_EVENT',
          entityType: 'invoice',
          entityId: 'invoice-1',
          afterValue: { status: 'recorded' }
        })
        .returning({ id: auditEvents.id });
      const auditId = inserted[0]?.id;
      expect(auditId).toBeDefined();

      const query =
        operation === 'update'
          ? database.pool.query(
              'update audit_events set event_type = $1 where id = $2',
              ['CHANGED', auditId]
            )
          : database.pool.query('delete from audit_events where id = $1', [
              auditId
            ]);

      await expect(query).rejects.toThrow('audit_events is append-only');
    }
  );
});
