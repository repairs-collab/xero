import { createDatabase, migrateDatabase } from '../packages/db/src/client.js';

export default async function integrationGlobalSetup(): Promise<void> {
  const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
  try {
    await migrateDatabase(client.db);
  } finally {
    await client.pool.end();
  }
}
