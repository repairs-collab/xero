import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from './connection.js';

export * from './connection.js';

export async function migrateDatabase(
  db: Database,
  migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
