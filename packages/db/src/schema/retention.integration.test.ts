import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';

const database = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

const columns = async (tableName: string): Promise<string[]> => {
  const result = await database.pool.query<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
};

beforeAll(async () => migrateDatabase(database.db));
afterAll(async () => database.pool.end());

describe('commercial retention schema', () => {
  it('stores additive deletion eligibility, backup review evidence and verified data-request deadlines', async () => {
    expect(await columns('retention_cases')).toEqual(
      expect.arrayContaining([
        'deletion_eligible_at',
        'closure_episode_id',
        'closure_version',
        'closure_effective_at',
        'backup_expiry_verified_at',
        'backup_expiry_evidence_reference',
        'backup_expiry_closure_episode_id'
      ])
    );
    expect(await columns('data_request_cases')).toEqual(
      expect.arrayContaining([
        'id',
        'organisation_id',
        'request_type',
        'status',
        'verification_reference',
        'idempotency_key',
        'verified_at',
        'target_at',
        'version',
        'block_reason',
        'last_reviewed_at',
        'last_reviewed_by_user_id',
        'retention_closure_episode_id',
        'completed_by_user_id',
        'completion_reference',
        'completion_export_audit_event_id'
      ])
    );
    expect(await columns('retention_operation_receipts')).toEqual(
      expect.arrayContaining([
        'organisation_id',
        'operation_id',
        'operation_type',
        'entity_id',
        'input_hash',
        'result_version',
        'created_at'
      ])
    );
  });

  it('reopens legacy completions that lack durable owner and export evidence before enforcing the new constraint', async () => {
    const migration = await readFile(
      new URL('../../drizzle/0036_simple_xorn.sql', import.meta.url),
      'utf8'
    );
    const reopen = migration.indexOf(
      'UPDATE "data_request_cases"\n   SET "status" = CASE'
    );
    const durableConstraint = migration.indexOf(
      'ADD CONSTRAINT "data_request_cases_completed_ck"'
    );

    expect(reopen).toBeGreaterThan(-1);
    expect(durableConstraint).toBeGreaterThan(reopen);
  });
});
