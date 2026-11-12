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
        'backup_expiry_verified_at',
        'backup_expiry_evidence_reference'
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
        'last_reviewed_by_user_id'
      ])
    );
  });
});
