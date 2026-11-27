import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { lifecycleEmailOutbox, organisations } from '../schema/index.js';
import { PostgresLifecycleEmailMonitoringRepository } from './lifecycle-email-monitoring-repository.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const repository = new PostgresLifecycleEmailMonitoringRepository(client.db);
const now = new Date('2126-11-22T02:00:00.000Z');

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

describe('lifecycle email monitoring repository', () => {
  it('returns exact cross-tenant metrics and only a capped, redacted, sanitized recent view', async () => {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const baseline = await repository.readSnapshot({ now, since, limit: 1 });
    const alpha = randomUUID();
    const beta = randomUUID();
    const firstTieId = `f${randomUUID().slice(1)}`;
    const secondTieId = `e${randomUUID().slice(1)}`;
    await client.db.insert(organisations).values([
      { id: alpha, xeroOrganisationId: randomUUID(), name: 'Alpha Repairs', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' },
      { id: beta, xeroOrganisationId: randomUUID(), name: 'Beta Services', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' }
    ]);
    const base = {
      recipient: 'private@example.invalid', template: 'WORKSPACE_WELCOME' as const,
      renderData: { organisationName: 'private-render-sentinel' },
      sourceType: 'private-source-type', expiresAt: new Date('2126-12-01T00:00:00.000Z')
    };
    await client.db.insert(lifecycleEmailOutbox).values([
      { ...base, organisationId: alpha, idempotencyKey: `pending-${alpha}`, sourceId: 'private-source-id', status: 'PENDING', createdAt: new Date('2026-11-22T00:00:00.000Z'), updatedAt: now },
      { ...base, organisationId: alpha, idempotencyKey: `retry-${alpha}`, sourceId: randomUUID(), status: 'RETRY', attempts: 1, lastAttemptedAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), nextAttemptAt: new Date(now.getTime() + 60 * 60 * 1_000), lastFailureCode: 'SMTP_CONNECTION_FAILURE', createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), updatedAt: new Date(now.getTime() - 1_000) },
      { ...base, organisationId: beta, idempotencyKey: `unknown-${beta}`, sourceId: randomUUID(), status: 'UNKNOWN', attempts: 1, lastAttemptedAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), lastFailureCode: 'SMTP_SUBMISSION_UNCERTAIN', createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), updatedAt: new Date(now.getTime() - 2_000) },
      { ...base, organisationId: beta, idempotencyKey: `failed-${beta}`, sourceId: randomUUID(), status: 'FAILED', attempts: 1, lastAttemptedAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), lastFailureCode: 'UNRECOGNISED_PRIVATE_CODE', createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), updatedAt: new Date(now.getTime() - 3_000) },
      { ...base, organisationId: beta, idempotencyKey: `sent-${beta}`, sourceId: randomUUID(), status: 'SENT', attempts: 1, lastAttemptedAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), sentAt: new Date(now.getTime() - 4_000), messageId: '<private_message@motts.com.au>', providerMessageId: 'private-provider-id', createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1_000), updatedAt: new Date(now.getTime() - 4_000) }
    ]);
    for (let index = 0; index < 51; index++) {
      await client.db.insert(lifecycleEmailOutbox).values({
        ...base,
        ...(index === 0 ? { id: firstTieId } : {}),
        ...(index === 1 ? { id: secondTieId } : {}),
        organisationId: alpha, idempotencyKey: `cap-${alpha}-${index}`,
        sourceId: randomUUID(), status: 'CANCELLED', lastFailureCode: index === 0 ? 'PRE_ACTIVATION_NOTICE' : null,
        createdAt: new Date(now.getTime() - (10 + Math.max(0, index - 1)) * 1_000),
        updatedAt: new Date(now.getTime() - (10 + Math.max(0, index - 1)) * 1_000)
      });
    }

    const result = await repository.readSnapshot({
      now, since, limit: 50
    });

    expect(result.metrics).toEqual({
      pendingOrRetry: baseline.metrics.pendingOrRetry + 2,
      unknown: baseline.metrics.unknown + 1,
      failedLast24Hours: baseline.metrics.failedLast24Hours + 1,
      sentLast24Hours: baseline.metrics.sentLast24Hours + 1
    });
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]?.status).toBe('PENDING');
    const equalTimestampRows = result.rows.filter(
      (row) => row.updatedAt.getTime() === now.getTime() - 10_000
    );
    expect(equalTimestampRows.map((row) => row.id)).toEqual([
      firstTieId,
      secondTieId
    ]);
    expect(result.rows.find((row) => row.status === 'FAILED')?.failureCategory).toBe('OTHER');
    expect(result.rows.find((row) => row.status === 'RETRY')?.failureCategory).toBe('DELIVERY_RETRY');
    expect(result.rows.find((row) => row.status === 'UNKNOWN')?.failureCategory).toBe('DELIVERY_UNCERTAIN');
    expect(result.rows.find((row) => row.id === firstTieId)?.failureCategory)
      .toBe('PRE_ACTIVATION');
    const serialized = JSON.stringify(result);
    for (const secret of [
      'private@example.invalid', 'private-render-sentinel', 'private-source-type',
      'private-source-id', 'private_message', 'private-provider-id', 'UNRECOGNISED_PRIVATE_CODE'
    ]) expect(serialized).not.toContain(secret);
  });
});
