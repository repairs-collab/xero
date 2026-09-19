import { eq } from 'drizzle-orm';

import {
  createDatabase,
  migrateDatabase,
  organisations
} from '@bc5000/db';
import { FetchHttpClient } from '@bc5000/integrations/http';
import {
  SinchClient,
  type SinchCredentials
} from '@bc5000/integrations/sinch';
import {
  requiredXeroScopes,
  XeroClient,
  XeroClientCredentialsTokenIssuer,
  XeroTokenCache
} from '@bc5000/integrations/xero';
import { DurableJobQueue, jobNames } from '@bc5000/jobs';

import { executeOperatorReply } from './handlers/operator-reply-execute.js';
import { testProviderConnection } from './handlers/provider-connection-test.js';
import { reconcileNightly } from './handlers/reconcile-nightly.js';
import { executeReminder } from './handlers/reminder-execute.js';
import { calculateReminderWork } from './handlers/reminders-calculate.js';
import { applyRetention } from './handlers/retention-apply.js';
import { processWebhookEvent } from './handlers/webhook-process.js';
import { runIncrementalSync } from './handlers/xero-incremental-sync.js';
import { runInitialSync } from './handlers/xero-initial-sync.js';
import { runInvoiceRefresh } from './handlers/xero-invoice-refresh.js';
import { startWorker } from './main.js';
import {
  databaseUrlFromEnvironment,
  parseProviderCredentials
} from './runtime-config.js';
import { waitForDatabaseMigrations } from './startup.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function main() {
  const databaseUrl = databaseUrlFromEnvironment(process.env);
  const databaseClient = createDatabase(databaseUrl);
  if (process.argv[2] === 'migrate') {
    await migrateDatabase(
      databaseClient.db,
      process.env.MIGRATIONS_DIR
    );
    await databaseClient.pool.end();
    return;
  }

  const credentials = parseProviderCredentials(process.env);
  const http = new FetchHttpClient();
  const tokenIssuer = new XeroClientCredentialsTokenIssuer(http, {
    readXeroClientCredentials: () => Promise.resolve(credentials.xero)
  });
  const xero = new XeroClient({
    http,
    tokenProvider: new XeroTokenCache(tokenIssuer)
  });
  const sinch = new SinchClient({
    http,
    credentials: credentials.sinch satisfies SinchCredentials,
    clock: { now: () => new Date() }
  });
  const clock = { now: () => new Date() };
  const syncDependencies = { database: databaseClient.db, xero, clock };
  const queue = new DurableJobQueue({
    databaseUrl,
    logger: console
  });
  const callbackUrl = `${required('PUBLIC_BASE_URL').replace(/\/$/, '')}/api/webhooks/sinch`;
  const allRows = await waitForDatabaseMigrations({
    load: async () => {
      const liveRows = await databaseClient.db
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.sendMode, 'live'));
      return liveRows.length > 0
        ? liveRows
        : databaseClient.db
            .select({ id: organisations.id })
            .from(organisations);
    }
  });

  await startWorker({
    queue,
    database: { close: () => databaseClient.pool.end() },
    organisationIds: allRows.map((row) => row.id),
    logger: console,
    handlers: {
      [jobNames.xeroInitialSync]: (payload) =>
        runInitialSync(syncDependencies, payload),
      [jobNames.xeroIncrementalSync]: (payload) =>
        runIncrementalSync(syncDependencies, payload),
      [jobNames.xeroInvoiceRefresh]: (payload) =>
        runInvoiceRefresh(syncDependencies, payload),
      [jobNames.xeroNightlyReconcile]: (payload) =>
        reconcileNightly(syncDependencies, payload).then(() => undefined),
      [jobNames.remindersCalculate]: (payload) =>
        calculateReminderWork(
          { database: databaseClient.db, clock },
          payload.organisationId
        ).then(() => undefined),
      [jobNames.reminderExecute]: (payload) =>
        executeReminder(
          {
            database: databaseClient.db,
            clock,
            xero,
            sinch,
            callbackUrl,
            xeroEmailAllowance: {
              hasSafeHeadroom: () => Promise.resolve(true)
            }
          },
          payload
        ).then(() => undefined),
      [jobNames.operatorReplyExecute]: (payload) =>
        executeOperatorReply(
          { database: databaseClient.db, clock, sinch, callbackUrl },
          payload
        ).then(() => undefined),
      [jobNames.webhookProcess]: (payload) =>
        processWebhookEvent(
          { database: databaseClient.db, publisher: queue },
          payload
        ),
      [jobNames.retentionApply]: (payload) =>
        applyRetention({ database: databaseClient.db, clock }, payload).then(
          () => undefined
        ),
      [jobNames.providerConnectionTest]: (payload) =>
        testProviderConnection(
          {
            database: databaseClient.db,
            clock,
            probe: {
              test: async ({ provider }) => {
                if (provider === 'XERO') {
                  const result = await xero.getOrganisation();
                  return {
                    healthy: true,
                    requiredScopes: [...requiredXeroScopes],
                    details: { organisationName: result.data.name }
                  };
                }
                await sinch.checkConnection();
                return {
                  healthy: true,
                  details: { region: 'APAC' }
                };
              }
            }
          },
          payload
        ).then(() => undefined)
    }
  });
}

void main().catch((error: unknown) => {
  console.error(
    'Bill Chaser worker failed to start',
    error instanceof Error ? error.message : 'Unknown error'
  );
  process.exitCode = 1;
});
