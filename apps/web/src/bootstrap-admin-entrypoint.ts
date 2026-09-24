import { createDatabase } from '@bc5000/db/web';

import { bootstrapFirstAdmin } from './server/bootstrap-admin.js';
import { createAwsCognitoUserAdministration } from './server/cognito-admin.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function main() {
  const database = createDatabase(required('DATABASE_URL'));
  try {
    const result = await bootstrapFirstAdmin(
      {
        database: database.db,
        cognito: createAwsCognitoUserAdministration(),
        clock: { now: () => new Date() }
      },
      {
        email: required('BOOTSTRAP_ADMIN_EMAIL'),
        displayName: required('BOOTSTRAP_ADMIN_DISPLAY_NAME'),
        organisationName: required('BOOTSTRAP_ORGANISATION_NAME'),
        xeroOrganisationId: required('BOOTSTRAP_XERO_ORGANISATION_ID'),
        timeZone: process.env.BOOTSTRAP_TIME_ZONE ?? 'Australia/Sydney',
        baseCurrency: process.env.BOOTSTRAP_BASE_CURRENCY ?? 'AUD'
      }
    );
    console.log(
      JSON.stringify({
        status: result.created ? 'created' : 'already-configured',
        organisationId: result.organisationId,
        userId: result.userId
      })
    );
  } finally {
    await database.pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    'Bill Chaser administrator bootstrap failed',
    error instanceof Error ? error.message : 'Unknown error'
  );
  process.exitCode = 1;
});
