import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  contacts,
  invoiceChases,
  invoices,
  organisations,
  reminderSequenceVersions,
  reminderSequences,
  stageInstances
} from '../schema/index.js';
import { PostgresChaseRepository } from './chase-repository.js';
import { PostgresWebhookRepository } from './webhook-repository.js';

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
    name: 'Repository Test Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await database.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Repository Test Customer',
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
    name: 'Repository sequence',
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

describe('PostgresChaseRepository', () => {
  it('allows exactly one concurrent claim for an idempotency key', async () => {
    const { organisationId, stageInstanceId } = await seedStageInstance();
    const repository = new PostgresChaseRepository(database.db);
    const input = {
      organisationId,
      stageInstanceId,
      channel: 'SMS' as const,
      recipientKey: '+61400000000',
      sourceVersion: 1,
      idempotencyKey: `${organisationId}:due-date:sms:+61400000000:v1`
    };

    const results = await Promise.all([
      repository.claimOutboundIntent(input),
      repository.claimOutboundIntent(input)
    ]);

    expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(
      1
    );
    expect(
      results.filter((result) => result.kind === 'already-exists')
    ).toHaveLength(1);
    expect(new Set(results.map((result) => result.outboundId)).size).toBe(1);
  });
});

describe('PostgresWebhookRepository', () => {
  it('deduplicates a stable provider event id', async () => {
    const { organisationId } = await seedStageInstance();
    const repository = new PostgresWebhookRepository(database.db);
    const input = {
      organisationId,
      provider: 'SINCH' as const,
      providerEventId: 'event-123',
      rawBody: '{"id":"event-123"}',
      signatureValid: true
    };

    await expect(repository.recordOnce(input)).resolves.toBe('recorded');
    await expect(repository.recordOnce(input)).resolves.toBe('duplicate');
  });

  it('deduplicates by body hash when the provider has no event id', async () => {
    const { organisationId } = await seedStageInstance();
    const repository = new PostgresWebhookRepository(database.db);
    const input = {
      organisationId,
      provider: 'XERO' as const,
      rawBody: '{"events":[]}',
      signatureValid: true
    };

    await expect(repository.recordOnce(input)).resolves.toBe('recorded');
    await expect(repository.recordOnce(input)).resolves.toBe('duplicate');
  });
});
