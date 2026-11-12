import { and, desc, eq } from 'drizzle-orm';

import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  operationalResetRuns,
  organisations,
  PostgresReplyNumberProvisioningRepository,
  PostgresSmsCommerceRepository,
  PostgresXeroConnectionRepository,
  providerConnections,
  PostgresVoiceCallRepository,
  retentionCases,
  subscriptions
} from '@bc5000/db';
import { FetchHttpClient } from '@bc5000/integrations/http';
import {
  SinchClient,
  type SinchCredentials
} from '@bc5000/integrations/sinch';
import { VoiceGatewayClient } from '@bc5000/integrations/voice-gateway';
import {
  AesGcmTokenCipher,
  requiredLegacyXeroScopes,
  XeroClientCredentialsTokenIssuer,
  XeroOAuthClient,
  XeroOAuthSessionProvider,
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
import { provisionPaidSmsNumber } from './handlers/sms-number-provision.js';
import { processSubscriptionLifecycle } from './handlers/subscription-lifecycle.js';
import { processTrialExpiry } from './handlers/trial-expiry.js';
import { executeVoiceCall } from './handlers/voice-call-execute.js';
import { reconcileVoiceCall } from './handlers/voice-call-reconcile.js';
import { calculateVoiceReminderWork } from './handlers/voice-reminders-calculate.js';
import { dispatchDueVoiceReminders } from './handlers/voice-reminders-dispatch.js';
import { processWebhookEvent } from './handlers/webhook-process.js';
import { runIncrementalSync } from './handlers/xero-incremental-sync.js';
import { runInitialSync } from './handlers/xero-initial-sync.js';
import { runInvoiceRefresh } from './handlers/xero-invoice-refresh.js';
import { cleanupExpiredXeroOAuthState } from './handlers/xero-oauth-cleanup.js';
import { startWorker } from './main.js';
import { createApprovedSmsRecoveryService } from './operations/approved-sms-recovery.js';
import {
  assertInboundReplyRecoveryComplete,
  createInboundReplyRecoveryService
} from './operations/inbound-reply-recovery.js';
import { createOperationalResetService } from './operations/operational-reset.js';
import { evaluateVoiceMonitor } from './operations/voice-monitor.js';
import {
  createDatabaseXeroOAuthReadinessLoader,
  createXeroOAuthReadinessService,
  parseXeroOAuthReadinessCommand
} from './operations/xero-oauth-readiness.js';
import { processInboundReply } from './services/inbound-reply-service.js';
import {
  databaseUrlFromEnvironment,
  parseApprovedSmsRecoveryCommand,
  parseInboundReplyRecoveryCommand,
  parseOperationalResetCommand,
  parseProviderCredentials,
  parseSinchCredentials
} from './runtime-config.js';
import { waitForDatabaseMigrations } from './startup.js';
import { OrganisationXeroClientFactory } from './xero-client-factory.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const requiredPositiveInteger = (name: string): number => {
  const raw = required(name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive whole number`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number`);
  }
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
  const xeroOAuthReadinessCommand =
    process.argv[2] === 'xero-oauth-readiness'
      ? parseXeroOAuthReadinessCommand(process.argv.slice(2))
      : null;
  const operationalResetCommand =
    process.argv[2] === 'migrate' ||
    voiceMonitorCommand ||
    approvedSmsRecoveryCommand !== null ||
    inboundReplyRecoveryCommand !== null ||
    xeroOAuthReadinessCommand !== null
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

  if (xeroOAuthReadinessCommand !== null) {
    try {
      const readiness = createXeroOAuthReadinessService(
        createDatabaseXeroOAuthReadinessLoader(databaseClient.db)
      );
      const report = await readiness.run(
        xeroOAuthReadinessCommand.organisationId
      );
      console.info(
        'AccountPulse Xero OAuth readiness\n' +
          JSON.stringify(report, null, 2)
      );
    } finally {
      await databaseClient.pool.end();
    }
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
      const sinchCredentials = parseSinchCredentials(process.env);
      const sinch = new SinchClient({
        http: new FetchHttpClient(),
        credentials: sinchCredentials satisfies SinchCredentials,
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
  const xeroOAuthClient = new XeroOAuthClient({
    http,
    ...credentials.xeroOAuth
  });
  const xeroTokenCipher = AesGcmTokenCipher.fromEnvironment({
    keysJson: credentials.xeroTokenEncryption.keysJson,
    activeKeyId: credentials.xeroTokenEncryption.activeKeyId
  });
  const xeroConnections = new PostgresXeroConnectionRepository(
    databaseClient.db
  );
  const legacyCredentials = credentials.xero;
  const legacyTokenProvider =
    legacyCredentials === null
      ? undefined
      : new XeroTokenCache(
          new XeroClientCredentialsTokenIssuer(http, {
            readXeroClientCredentials: () =>
              Promise.resolve(legacyCredentials)
          })
        );
  const xeroFactory = new OrganisationXeroClientFactory({
    http,
    connectionStore: xeroConnections,
    tokenCipher: xeroTokenCipher,
    oauthClient: xeroOAuthClient,
    legacyConnectionEnabled: async (organisationId) => {
      const [connection] = await databaseClient.db
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.organisationId, organisationId),
            eq(providerConnections.provider, 'XERO'),
            eq(providerConnections.enabled, true)
          )
        )
        .limit(1);
      return connection !== undefined;
    },
    ...(legacyTokenProvider === undefined ? {} : { legacyTokenProvider })
  });
  const sinch = new SinchClient({
    http,
    credentials: credentials.sinch satisfies SinchCredentials,
    clock: { now: () => new Date() }
  });
  const clock = { now: () => new Date() };
  const voiceCallRepository = new PostgresVoiceCallRepository(
    databaseClient.db
  );
  const smsCommerceRepository = new PostgresSmsCommerceRepository(
    databaseClient.db
  );
  const replyNumberProvisioningRepository =
    new PostgresReplyNumberProvisioningRepository(databaseClient.db);
  const voiceGateway = new VoiceGatewayClient({
    http,
    signingSecret: required('VOICE_GATEWAY_SIGNING_SECRET'),
    baseUrl: process.env.VOICE_GATEWAY_URL ?? 'http://voice-gateway:3105'
  });
  const queue = new DurableJobQueue({
    databaseUrl,
    logger: console
  });
  const callbackUrl = `${required('PUBLIC_BASE_URL').replace(/\/$/, '')}/api/webhooks/sinch`;
  const voiceGatewayCallbackUrl = `${required('PUBLIC_BASE_URL').replace(/\/$/, '')}/api/webhooks/voice-gateway`;
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
      [jobNames.xeroInitialSync]: async (payload) =>
        runInitialSync(
          {
            database: databaseClient.db,
            xero: await xeroFactory.forOrganisation(payload.organisationId),
            clock
          },
          payload
        ),
      [jobNames.xeroIncrementalSync]: async (payload) =>
        runIncrementalSync(
          {
            database: databaseClient.db,
            xero: await xeroFactory.forOrganisation(payload.organisationId),
            clock
          },
          payload
        ),
      [jobNames.xeroInvoiceRefresh]: async (payload) =>
        runInvoiceRefresh(
          {
            database: databaseClient.db,
            xero: await xeroFactory.forOrganisation(payload.organisationId),
            clock
          },
          payload
        ),
      [jobNames.xeroNightlyReconcile]: async (payload) =>
        reconcileNightly(
          {
            database: databaseClient.db,
            xero: await xeroFactory.forOrganisation(payload.organisationId),
            clock
          },
          payload
        ).then(() => undefined),
      [jobNames.remindersCalculate]: async (payload) =>
        runReminderCycle(
          {
            database: databaseClient.db,
            clock,
            xero: await xeroFactory.forOrganisation(payload.organisationId),
            holidays: { list: () => [] },
            publisher: queue
          },
          payload.organisationId
        ).then(() => undefined),
      [jobNames.voiceRemindersCalculate]: (payload) =>
        calculateVoiceReminderWork(
          { database: databaseClient.db, clock, holidays: { list: () => [] } },
          payload.organisationId
        ).then(() => undefined),
      [jobNames.voiceRemindersDispatch]: (payload) =>
        dispatchDueVoiceReminders(
          {
            database: databaseClient.db,
            repository: voiceCallRepository,
            clock,
            holidays: { list: () => [] },
            publisher: queue,
            acceptCustomerVoiceCalls:
              process.env.VOICE_GATEWAY_ACCEPT_CALLS === 'true'
          },
          payload.organisationId
        ).then(() => undefined),
      [jobNames.reminderExecute]: async (payload) =>
        executeReminder(
          {
            database: databaseClient.db,
            clock,
            xero: await xeroFactory.forOrganisation(payload.organisationId),
            sinch,
            callbackUrl,
            holidays: { list: () => [] },
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
      [jobNames.smsNumberProvision]: (payload) =>
        provisionPaidSmsNumber(
          { repository: replyNumberProvisioningRepository, clock },
          payload
        ).then(() => undefined),
      [jobNames.voiceCallExecute]: (payload) =>
        executeVoiceCall(
          {
            database: databaseClient.db,
            repository: voiceCallRepository,
            clock,
            gateway: voiceGateway,
            gatewayCallbackUrl: voiceGatewayCallbackUrl,
            publisher: queue,
            holidays: { list: () => [] },
            acceptCustomerVoiceCalls:
              process.env.VOICE_GATEWAY_ACCEPT_CALLS === 'true'
          },
          payload
        ).then(() => undefined),
      [jobNames.voiceCallReconcile]: (payload) =>
        reconcileVoiceCall(
          {
            database: databaseClient.db,
            clock,
            gateway: voiceGateway,
            publisher: queue
          },
          payload
        ).then(() => undefined),
      [jobNames.webhookProcess]: (payload) =>
        processWebhookEvent(
          { database: databaseClient.db, publisher: queue },
          payload
        ),
      [jobNames.xeroOAuthCleanup]: () =>
        cleanupExpiredXeroOAuthState({
          database: databaseClient.db,
          clock
        }).then(() => undefined),
      [jobNames.retentionApply]: (payload) =>
        applyRetention({ database: databaseClient.db, clock }, payload).then(
          () => undefined
        ),
      [jobNames.subscriptionLifecycle]: (payload) =>
        processSubscriptionLifecycle(
          {
            load: async (organisationId) => {
              const [subscription] = await databaseClient.db
                .select({
                  status: subscriptions.status,
                  cancelledAt: subscriptions.cancelledAt
                })
                .from(subscriptions)
                .where(eq(subscriptions.organisationId, organisationId))
                .limit(1);
              if (subscription === undefined) return null;
              const [retentionCase] = await databaseClient.db
                .select({ organisationId: retentionCases.organisationId })
                .from(retentionCases)
                .where(eq(retentionCases.organisationId, organisationId))
                .limit(1);
              return {
                ...subscription,
                retentionDeadlineRecorded: retentionCase !== undefined
              };
            },
            disconnectXero: async (organisationId) => {
              const connection =
                await xeroConnections.findByOrganisationId(organisationId);
              if (connection === null || connection.status === 'DISCONNECTED') {
                return;
              }
              const session = await new XeroOAuthSessionProvider({
                organisationId,
                store: xeroConnections,
                tokenCipher: xeroTokenCipher,
                oauthClient: xeroOAuthClient
              }).getSession();
              await xeroOAuthClient.deleteConnection(
                session.accessToken,
                connection.connectionId
              );
              await xeroConnections.disconnect(organisationId, clock.now());
            },
            quarantineSmsNumber: async (organisationId, now) => {
              const quarantineDays = requiredPositiveInteger(
                'SMS_NUMBER_QUARANTINE_DAYS'
              );
              await smsCommerceRepository.quarantineNumber(
                organisationId,
                new Date(
                  now.getTime() + quarantineDays * 24 * 60 * 60 * 1000
                ),
                now
              );
            },
            recordRetentionDeadline: async (input) => {
              await databaseClient.db.transaction(async (transaction) => {
                const inserted = await transaction
                  .insert(retentionCases)
                  .values({
                    organisationId: input.organisationId,
                    source: 'SUBSCRIPTION_CANCELLED',
                    status: 'SCHEDULED',
                    disconnectedAt: input.disconnectedAt,
                    reviewAfter: input.retentionDeadline,
                    deletionEligibleAt: input.deletionEligibleAt,
                    updatedAt: input.disconnectedAt
                  })
                  .onConflictDoNothing({
                    target: retentionCases.organisationId
                  })
                  .returning({ organisationId: retentionCases.organisationId });
                if (inserted.length === 0) return;
                await transaction.insert(auditEvents).values({
                  organisationId: input.organisationId,
                  eventType: 'SUBSCRIPTION_RETENTION_SCHEDULED',
                  entityType: 'SUBSCRIPTION',
                  entityId: input.organisationId,
                  afterValue: {
                    disconnectedAt: input.disconnectedAt.toISOString(),
                    retentionDeadline: input.retentionDeadline.toISOString(),
                    deletionEligibleAt:
                      input.deletionEligibleAt?.toISOString() ?? null
                  },
                  occurredAt: input.disconnectedAt
                });
              });
            },
            clock
          },
          payload
        ).then(() => undefined),
      [jobNames.subscriptionTrialExpiry]: (payload) =>
        processTrialExpiry(
          {
            load: async (organisationId) => {
              const [subscription] = await databaseClient.db
                .select({
                  status: subscriptions.status,
                  trialEndsAt: subscriptions.trialEndsAt
                })
                .from(subscriptions)
                .where(eq(subscriptions.organisationId, organisationId))
                .limit(1);
              if (subscription === undefined) return null;
              const [retentionCase] = await databaseClient.db
                .select({ organisationId: retentionCases.organisationId })
                .from(retentionCases)
                .where(eq(retentionCases.organisationId, organisationId))
                .limit(1);
              return {
                ...subscription,
                retentionDeadlineRecorded: retentionCase !== undefined
              };
            },
            pauseScheduledWork: async (organisationId, now) => {
              await databaseClient.db
                .update(organisations)
                .set({
                  sendMode: 'dry-run',
                  rolloutScope: 'CONTROLLED',
                  liveSendAcknowledged: false,
                  updatedAt: now
                })
                .where(eq(organisations.id, organisationId));
            },
            disconnectXero: async (organisationId) => {
              const connection =
                await xeroConnections.findByOrganisationId(organisationId);
              if (connection === null || connection.status === 'DISCONNECTED') {
                return;
              }
              const session = await new XeroOAuthSessionProvider({
                organisationId,
                store: xeroConnections,
                tokenCipher: xeroTokenCipher,
                oauthClient: xeroOAuthClient
              }).getSession();
              await xeroOAuthClient.deleteConnection(
                session.accessToken,
                connection.connectionId
              );
              await xeroConnections.disconnect(organisationId, clock.now());
            },
            recordRetentionDeadline: async (input) => {
              await databaseClient.db.transaction(async (transaction) => {
                const inserted = await transaction
                  .insert(retentionCases)
                  .values({
                    organisationId: input.organisationId,
                    source: 'TRIAL_EXPIRED',
                    status: 'SCHEDULED',
                    disconnectedAt: input.disconnectedAt,
                    reviewAfter: input.retentionDeadline,
                    updatedAt: input.disconnectedAt
                  })
                  .onConflictDoNothing({
                    target: retentionCases.organisationId
                  })
                  .returning({ organisationId: retentionCases.organisationId });
                if (inserted.length === 0) return;
                await transaction.insert(auditEvents).values({
                  organisationId: input.organisationId,
                  eventType: 'TRIAL_RETENTION_SCHEDULED',
                  entityType: 'SUBSCRIPTION',
                  entityId: input.organisationId,
                  afterValue: {
                    disconnectedAt: input.disconnectedAt.toISOString(),
                    retentionDeadline: input.retentionDeadline.toISOString()
                  },
                  occurredAt: input.disconnectedAt
                });
              });
            },
            clock
          },
          payload
        ).then(() => undefined),
      [jobNames.providerConnectionTest]: (payload) =>
        testProviderConnection(
          {
            database: databaseClient.db,
            clock,
            probe: {
              test: async ({ organisationId, provider }) => {
                if (provider === 'XERO') {
                  const xero = await xeroFactory.forOrganisation(
                    organisationId
                  );
                  const result = await xero.getOrganisation();
                  return {
                    healthy: true,
                    requiredScopes: [...requiredLegacyXeroScopes],
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
