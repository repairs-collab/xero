import { and, desc, eq } from 'drizzle-orm';

import {
  createDatabase,
  migrateDatabase,
  operationalResetRuns,
  organisations,
  PostgresVoiceCallRepository
} from '@bc5000/db';
import { FetchHttpClient } from '@bc5000/integrations/http';
import { RetellClient } from '@bc5000/integrations/retell';
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
import { runReminderCycle } from './handlers/automatic-reminder-dispatch.js';
import { applyRetention } from './handlers/retention-apply.js';
import { executeTestSms } from './handlers/test-sms-execute.js';
import { executeVoiceCall } from './handlers/voice-call-execute.js';
import { reconcileVoiceCall } from './handlers/voice-call-reconcile.js';
import { calculateVoiceReminderWork } from './handlers/voice-reminders-calculate.js';
import { processWebhookEvent } from './handlers/webhook-process.js';
import { runIncrementalSync } from './handlers/xero-incremental-sync.js';
import { runInitialSync } from './handlers/xero-initial-sync.js';
import { runInvoiceRefresh } from './handlers/xero-invoice-refresh.js';
import { startWorker } from './main.js';
import { createApprovedSmsRecoveryService } from './operations/approved-sms-recovery.js';
import {
  assertInboundReplyRecoveryComplete,
  createInboundReplyRecoveryService
} from './operations/inbound-reply-recovery.js';
import { createOperationalResetService } from './operations/operational-reset.js';
import { evaluateVoiceMonitor } from './operations/voice-monitor.js';
import { processInboundReply } from './services/inbound-reply-service.js';
import {
  createEnvironmentSecretReader,
  databaseUrlFromEnvironment,
  parseApprovedSmsRecoveryCommand,
  parseInboundReplyRecoveryCommand,
  parseOperationalResetCommand,
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
  const voiceMonitorCommand = process.argv[2] === 'voice-monitor';
  const approvedSmsRecoveryCommand =
    process.argv[2] === 'recover-approved-sms'
      ? parseApprovedSmsRecoveryCommand(process.argv.slice(2))
      : null;
  const inboundReplyRecoveryCommand =
    process.argv[2] === 'recover-inbound-replies'
      ? parseInboundReplyRecoveryCommand(process.argv.slice(2))
      : null;
  const operationalResetCommand =
    process.argv[2] === 'migrate' ||
    voiceMonitorCommand ||
    approvedSmsRecoveryCommand !== null ||
    inboundReplyRecoveryCommand !== null
      ? null
      : parseOperationalResetCommand(process.argv.slice(2));
  const databaseClient = createDatabase(databaseUrl);
  if (process.argv[2] === 'migrate') {
    await migrateDatabase(
      databaseClient.db,
      process.env.MIGRATIONS_DIR
    );
    await databaseClient.pool.end();
    return;
  }

  if (voiceMonitorCommand) {
    try {
      const result = await databaseClient.pool.query<{
        unknown_outcomes: string;
        provider_failures: string;
        queue_age_seconds: string;
        webhook_lag_seconds: string;
      }>(`select
        (select count(*)::text from voice_call_requests where state = 'UNKNOWN') as unknown_outcomes,
        (select count(*)::text from voice_call_requests where state = 'FAILED' and updated_at >= now() - interval '15 minutes') as provider_failures,
        (select coalesce(extract(epoch from (now() - min(created_on))), 0)::text from pgboss.job where name in ('voice-call.execute', 'voice-call.reconcile') and state in ('created', 'retry')) as queue_age_seconds,
        (select coalesce(extract(epoch from (now() - min(received_at))), 0)::text from webhook_events where provider = 'RETELL' and processed_at is null) as webhook_lag_seconds`);
      const row = result.rows[0];
      if (!row) throw new Error('Voice monitor query returned no result');
      const threshold = (name: string, fallback: number): number => {
        const value = Number(process.env[name] ?? fallback);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`${name} must be a non-negative number`);
        }
        return value;
      };
      const report = evaluateVoiceMonitor(
        {
          voiceUnknownOutcomesTotal: Number(row.unknown_outcomes),
          voiceProviderFailuresTotal: Number(row.provider_failures),
          voiceQueueAgeSeconds: Math.floor(Number(row.queue_age_seconds)),
          retellWebhookLagSeconds: Math.floor(Number(row.webhook_lag_seconds))
        },
        {
          queueAgeSeconds: threshold('VOICE_QUEUE_AGE_ALARM_SECONDS', 300),
          webhookLagSeconds: threshold('RETELL_WEBHOOK_LAG_ALARM_SECONDS', 300)
        }
      );
      for (const metric of report.metrics) {
        console.info('AccountPulse operational metric', metric);
      }
      if (!report.healthy) {
        console.error('AccountPulse voice monitor alarm', {
          alarms: report.alarms
        });
        process.exitCode = 2;
      }
    } finally {
      await databaseClient.pool.end();
    }
    return;
  }

  if (inboundReplyRecoveryCommand !== null) {
    try {
      let recoveryOrganisationId = inboundReplyRecoveryCommand.organisationId;
      if (recoveryOrganisationId === undefined) {
        const organisationRows = await databaseClient.db
          .select({ id: organisations.id })
          .from(organisations)
          .limit(2);
        if (organisationRows.length !== 1 || organisationRows[0] === undefined) {
          throw new Error(
            'organisation-id is required unless exactly one organisation exists'
          );
        }
        recoveryOrganisationId = organisationRows[0].id;
      }
      const credentials = parseProviderCredentials(process.env);
      const sinch = new SinchClient({
        http: new FetchHttpClient(),
        credentials: credentials.sinch satisfies SinchCredentials,
        clock: { now: () => new Date() }
      });
      const [latestCompletedReset] = await databaseClient.db
        .select({ completedAt: operationalResetRuns.completedAt })
        .from(operationalResetRuns)
        .where(
          and(
            eq(
              operationalResetRuns.organisationId,
              recoveryOrganisationId
            ),
            eq(operationalResetRuns.status, 'COMPLETED')
          )
        )
        .orderBy(desc(operationalResetRuns.completedAt))
        .limit(1);
      const recovery = createInboundReplyRecoveryService({
        sinch,
        processReply: async (event) => {
          const receivedAt = new Date(event.receivedAt);
          if (!Number.isFinite(receivedAt.getTime())) {
            throw new Error('Sinch reply has an invalid received timestamp');
          }
          if (
            latestCompletedReset?.completedAt !== null &&
            latestCompletedReset?.completedAt !== undefined &&
            receivedAt <= latestCompletedReset.completedAt
          ) {
            return 'skipped';
          }
          await processInboundReply(
            databaseClient.db,
            recoveryOrganisationId,
            event,
            {
              recoverySource: 'SINCH_UNCONFIRMED_REPLIES',
              replyId: event.replyId,
              messageId: event.messageId
            }
          );
          return 'processed';
        }
      });
      const result = await recovery.run();
      console.info('Inbound reply recovery result', {
        organisationId: recoveryOrganisationId,
        result
      });
      assertInboundReplyRecoveryComplete(result);
      console.info('Inbound reply recovery command completed', {
        organisationId: recoveryOrganisationId,
        confirmed: result.confirmed,
        processed: result.processed,
        skipped: result.skipped
      });
    } finally {
      await databaseClient.pool.end();
    }
    return;
  }

  if (approvedSmsRecoveryCommand !== null) {
    const recoveryQueue = new DurableJobQueue({
      databaseUrl,
      logger: console
    });
    try {
      if (approvedSmsRecoveryCommand.kind === 'execute') {
        await recoveryQueue.start();
      }
      const recovery = createApprovedSmsRecoveryService({
        database: databaseClient.db,
        clock: { now: () => new Date() },
        publisher: recoveryQueue
      });
      const result =
        approvedSmsRecoveryCommand.kind === 'preview'
          ? await recovery.preview(approvedSmsRecoveryCommand.input)
          : await recovery.execute(approvedSmsRecoveryCommand.input);
      console.info('Approved SMS recovery command completed', {
        operation: approvedSmsRecoveryCommand.kind,
        organisationId: approvedSmsRecoveryCommand.input.organisationId,
        localDate: approvedSmsRecoveryCommand.input.localDate,
        result
      });
    } finally {
      await recoveryQueue.stop();
      await databaseClient.pool.end();
    }
    return;
  }

  if (operationalResetCommand !== null) {
    try {
      const reset = createOperationalResetService({
        database: databaseClient.db,
        clock: { now: () => new Date() }
      });
      if (operationalResetCommand.kind === 'prepare') {
        await reset.prepare(operationalResetCommand.input);
      } else if (operationalResetCommand.kind === 'execute') {
        await reset.execute(operationalResetCommand.input);
      } else {
        await reset.abort(operationalResetCommand.input);
      }
      console.info('Operational reset command completed', {
        operation: operationalResetCommand.kind,
        organisationId: operationalResetCommand.input.organisationId,
        resetRunId: operationalResetCommand.input.resetRunId
      });
    } finally {
      await databaseClient.pool.end();
    }
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
  const voiceCallRepository = new PostgresVoiceCallRepository(
    databaseClient.db
  );
  const voiceSecretReader = createEnvironmentSecretReader(process.env);
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
        runReminderCycle(
          { database: databaseClient.db, clock, xero, publisher: queue },
          payload.organisationId
        ).then(() => undefined),
      [jobNames.voiceRemindersCalculate]: (payload) =>
        calculateVoiceReminderWork(
          { database: databaseClient.db, clock, holidays: { list: () => [] } },
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
      [jobNames.testSmsExecute]: (payload) =>
        executeTestSms(
          { database: databaseClient.db, clock, sinch, callbackUrl },
          payload
        ).then(() => undefined),
      [jobNames.voiceCallExecute]: (payload) =>
        executeVoiceCall(
          {
            database: databaseClient.db,
            repository: voiceCallRepository,
            clock,
            secrets: voiceSecretReader,
            providerFactory: {
              create: (apiKey) => new RetellClient({ http, apiKey })
            },
            publisher: queue,
            holidays: { list: () => [] }
          },
          payload
        ).then(() => undefined),
      [jobNames.voiceCallReconcile]: (payload) =>
        reconcileVoiceCall(
          {
            database: databaseClient.db,
            clock,
            secrets: voiceSecretReader,
            providerFactory: {
              create: (apiKey) => new RetellClient({ http, apiKey })
            },
            publisher: queue
          },
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
