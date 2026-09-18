import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
type TransactionCallback = Parameters<Database['transaction']>[0];
export type DbTransaction = Parameters<TransactionCallback>[0];

export interface DatabaseClient {
  db: Database;
  pool: Pool;
}

export function createDatabase(databaseUrl: string): DatabaseClient {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    pool,
    db: drizzle(pool, { schema })
  };
}

export async function migrateDatabase(db: Database): Promise<void> {
  const migrationsFolder = fileURLToPath(
    new URL('../drizzle', import.meta.url)
  );
  await migrate(db, { migrationsFolder });
}
