import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/src/schema/index.js',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://bc5000:bc5000@localhost:5432/bc5000'
  },
  strict: true,
  verbose: true
});
