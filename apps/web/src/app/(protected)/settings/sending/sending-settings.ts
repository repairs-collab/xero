import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  sql
} from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  approvals,
  auditEvents,
  contacts,
  type Database,
  type DbTransaction,
  invoices,
  operationalResetRuns,
  organisations,
  outboundMessages,
  PostgresOrganisationSafetyRepository,
  providerConnections,
  reminderSequences,
  rolloutReconciliations
} from '@bc5000/db/web';

export const LIVE_ACKNOWLEDGEMENT =
  'I understand live reminders will be sent to customers';
export const RECONCILIATION_ACKNOWLEDGEMENT =
  'I confirm these figures match the current Xero receivables for this sync';
export const CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT =
  'I understand approved reminders may be sent to customers';
export const CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT =
  'OVERRIDE SETUP CHECKS AND ENABLE CUSTOMER LIVE';

export interface LiveActivationFeedback {
  tone: 'error' | 'success';
  title: string;
  detail: string;
}

export interface ReconciliationMetrics {
  activeContactCount: number;
  outstandingInvoiceCount: number;
  outstandingTotals: Record<string, string>;
  generatedApprovalCount: number;
  enabledSequenceCount: number;
  allEnabledSequencesReview: boolean;
}

interface ReadinessGate<T = undefined> {
  passed: boolean;
  evidence: T;
}

export interface CustomerRolloutReadiness {
  organisationId: string;
  operationalState: string;
  operationalStateVersion: number;
  metrics: ReconciliationMetrics;
  gates: {
    controlledLive: ReadinessGate<{
      sendMode: 'dry-run' | 'live';
      rolloutScope: 'CONTROLLED' | 'CUSTOMER';
    }>;
    providersHealthy: ReadinessGate<
      Array<{
        id: string;
        provider: 'XERO' | 'SINCH';
        authenticatedAt: Date;
      }>
    >;
    syncFresh: ReadinessGate<{ timestamp: Date | null }>;
    importedDataPresent: ReadinessGate<{
      activeContactCount: number;
      outstandingInvoiceCount: number;
    }>;
    controlledSmsEvidence: ReadinessGate<{
      id: string;
      status: 'ACCEPTED' | 'DELIVERED';
      timestamp: Date;
    } | null>;
    resetIdle: ReadinessGate<{ activeResetId: string | null }>;
    enabledSequencesReview: ReadinessGate<{
      enabledSequenceCount: number;
    }>;
    reconciliationCurrent: ReadinessGate<{
      id: string;
      syncCompletedAt: Date;
      acknowledgedAt: Date;
    } | null>;
  };
  readyForCustomerAcknowledgement: boolean;
}

type Executor = Database | DbTransaction;

const activationErrors = new Set([
  'ACKNOWLEDGEMENT_MISMATCH',
  'PROVIDERS_UNHEALTHY',
  'XERO_SYNC_STALE',
  'ALLOWLIST_REQUIRED',
  'FORBIDDEN'
]);

const activeResetStatuses = [
  'PREPARING',
  'SNAPSHOT_CREATED',
  'RESETTING',
  'FAILED'
] as const;

export const liveActivationStatusForError = (error: unknown): string =>
  error instanceof Error && activationErrors.has(error.message)
    ? error.message
    : 'ACTIVATION_FAILED';

export const liveActivationFeedback = (
  status: string | string[] | undefined
): LiveActivationFeedback | null => {
  const value = Array.isArray(status) ? status[0] : status;
  switch (value) {
    case 'enabled':
      return {
        tone: 'success',
        title: 'Controlled live mode enabled',
        detail:
          'Provider calls are open only for destinations on the technical recipient allowlist. Complete the controlled tests before the final customer rollout.'
      };
    case 'ACKNOWLEDGEMENT_MISMATCH':
      return {
        tone: 'error',
        title: 'The acknowledgement did not match',
        detail: 'Type the acknowledgement exactly as shown, then try again.'
      };
    case 'PROVIDERS_UNHEALTHY':
      return {
        tone: 'error',
        title: 'Provider checks are out of date',
        detail:
          'Run successful Xero and Sinch connection tests, then try again within 24 hours.'
      };
    case 'XERO_SYNC_STALE':
      return {
        tone: 'error',
        title: 'Xero data is not fresh enough',
        detail: 'Run a Xero sync, then try again within 15 minutes.'
      };
    case 'ALLOWLIST_REQUIRED':
      return {
        tone: 'error',
        title: 'Add a controlled recipient first',
        detail:
          'Add at least one company-controlled phone number or email address to the recipient allowlist.'
      };
    case 'FORBIDDEN':
      return {
        tone: 'error',
        title: 'Administrator access is required',
        detail: 'Only an AccountPulse administrator can enable live sending.'
      };
    case undefined:
      return null;
    default:
      return {
        tone: 'error',
        title: 'Live sending was not enabled',
        detail:
          'No provider calls were opened. Refresh the page and check each launch-readiness item before trying again.'
      };
  }
};

const normaliseAllowlistRecipient = (rawValue: string): string => {
  const value = rawValue.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return value.toLowerCase();
  }
  const parsed = parsePhoneNumberFromString(value, 'AU');
  if (!parsed?.isValid()) {
    throw new Error(`INVALID_ALLOWLIST_RECIPIENT:${rawValue}`);
  }
  return parsed.number;
};

const requiredReason = (rawReason: string): void => {
  const reason = rawReason.trim();
  if (reason.length === 0) throw new Error('REASON_REQUIRED');
  if (reason.length > 500) throw new Error('REASON_TOO_LONG');
};

const sameTimestamp = (left: Date | null, right: string): boolean => {
  if (left === null) return false;
  const parsed = new Date(right);
  return !Number.isNaN(parsed.getTime()) && left.getTime() === parsed.getTime();
};

const canonicalMetrics = (metrics: ReconciliationMetrics): string =>
  JSON.stringify({
    activeContactCount: metrics.activeContactCount,
    outstandingInvoiceCount: metrics.outstandingInvoiceCount,
    outstandingTotals: Object.fromEntries(
      Object.entries(metrics.outstandingTotals).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
    generatedApprovalCount: metrics.generatedApprovalCount,
    enabledSequenceCount: metrics.enabledSequenceCount,
    allEnabledSequencesReview: metrics.allEnabledSequencesReview
  });

async function getReconciliationMetrics(
  database: Executor,
  organisationId: string
): Promise<ReconciliationMetrics> {
  const [activeContacts] = await database
    .select({ value: count() })
    .from(contacts)
    .where(
      and(
        eq(contacts.organisationId, organisationId),
        eq(contacts.active, true)
      )
    );
  const totals = await database
    .select({
      currency: invoices.currency,
      invoiceCount: count(),
      amount: sql<string>`sum(${invoices.amountDue})`
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organisationId, organisationId),
        eq(invoices.type, 'ACCREC'),
        eq(invoices.status, 'AUTHORISED'),
        gt(invoices.amountDue, '0')
      )
    )
    .groupBy(invoices.currency)
    .orderBy(invoices.currency);
  const [pendingApprovals] = await database
    .select({ value: count() })
    .from(approvals)
    .where(
      and(
        eq(approvals.organisationId, organisationId),
        eq(approvals.status, 'PENDING')
      )
    );
  const enabledSequences = await database
    .select({ mode: reminderSequences.mode })
    .from(reminderSequences)
    .where(
      and(
        eq(reminderSequences.organisationId, organisationId),
        eq(reminderSequences.enabled, true)
      )
    );

  return {
    activeContactCount: activeContacts?.value ?? 0,
    outstandingInvoiceCount: totals.reduce(
      (total, row) => total + row.invoiceCount,
      0
    ),
    outstandingTotals: Object.fromEntries(
      totals.map((row) => [row.currency, row.amount])
    ),
    generatedApprovalCount: pendingApprovals?.value ?? 0,
    enabledSequenceCount: enabledSequences.length,
    allEnabledSequencesReview: enabledSequences.every(
      (sequence) => sequence.mode === 'REVIEW'
    )
  };
}

async function lockCustomerRolloutEvidence(
  transaction: DbTransaction,
  organisationId: string
): Promise<void> {
  await transaction
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(eq(providerConnections.organisationId, organisationId))
    .for('update');
  await transaction
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.organisationId, organisationId))
    .for('update');
  await transaction
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.organisationId, organisationId))
    .for('update');
  await transaction
    .select({ id: approvals.id })
    .from(approvals)
    .where(eq(approvals.organisationId, organisationId))
    .for('update');
  await transaction
    .select({ id: reminderSequences.id })
    .from(reminderSequences)
    .where(eq(reminderSequences.organisationId, organisationId))
    .for('update');
  await transaction
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.organisationId, organisationId),
        eq(outboundMessages.source, 'TEST_SMS')
      )
    )
    .for('update');
  await transaction
    .select({ id: rolloutReconciliations.id })
    .from(rolloutReconciliations)
    .where(eq(rolloutReconciliations.organisationId, organisationId))
    .for('update');
  await transaction
    .select({ id: operationalResetRuns.id })
    .from(operationalResetRuns)
    .where(eq(operationalResetRuns.organisationId, organisationId))
    .for('update');
}

const failedReadinessGatesAt = (
  readiness: CustomerRolloutReadiness,
  now: Date
): string[] => {
  const failed = Object.entries(readiness.gates)
    .filter(([, gate]) => !gate.passed)
    .map(([key]) => key);
  const providerEvidence = readiness.gates.providersHealthy.evidence;
  const providersCurrent = (['XERO', 'SINCH'] as const).every((provider) =>
    providerEvidence.some((evidence) => {
      const age = now.getTime() - evidence.authenticatedAt.getTime();
      return provider === evidence.provider && age >= 0 && age <= 24 * 60 * 60_000;
    })
  );
  const syncTimestamp = readiness.gates.syncFresh.evidence.timestamp;
  const syncAge =
    syncTimestamp === null
      ? Number.POSITIVE_INFINITY
      : now.getTime() - syncTimestamp.getTime();
  const smsTimestamp = readiness.gates.controlledSmsEvidence.evidence?.timestamp;
  const smsAge =
    smsTimestamp === undefined
      ? Number.POSITIVE_INFINITY
      : now.getTime() - smsTimestamp.getTime();
  if (!providersCurrent && !failed.includes('providersHealthy')) {
    failed.push('providersHealthy');
  }
  if (
    (syncAge < 0 || syncAge > 15 * 60_000) &&
    !failed.includes('syncFresh')
  ) {
    failed.push('syncFresh');
  }
  if (
    (smsAge < 0 || smsAge > 7 * 24 * 60 * 60_000) &&
    !failed.includes('controlledSmsEvidence')
  ) {
    failed.push('controlledSmsEvidence');
  }
  return failed;
};

async function calculateCustomerRolloutReadiness(
  database: Executor,
  input: { organisationId: string; now: Date }
): Promise<CustomerRolloutReadiness> {
  const [organisation] = await database
    .select()
    .from(organisations)
    .where(eq(organisations.id, input.organisationId))
    .limit(1);
  if (!organisation) throw new Error('ORGANISATION_NOT_FOUND');

  const healthySince = new Date(input.now.getTime() - 24 * 60 * 60_000);
  const recentSmsSince = new Date(input.now.getTime() - 7 * 24 * 60 * 60_000);
  // This helper also runs on a single transaction connection during final
  // activation, so keep its reads sequential rather than multiplexing a pg
  // client that only supports one active query.
  const metrics = await getReconciliationMetrics(
    database,
    input.organisationId
  );
  const providers = await database
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
      connectedAt: providerConnections.connectedAt,
      authenticatedAt: providerConnections.lastSuccessfulAuthenticationAt
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organisationId, input.organisationId),
        eq(providerConnections.enabled, true),
        gte(providerConnections.lastSuccessfulAuthenticationAt, healthySince),
        lte(providerConnections.lastSuccessfulAuthenticationAt, input.now)
      )
    );
  const recentTestMessages = await database
    .select({
      id: outboundMessages.id,
      status: outboundMessages.status,
      recipientKey: outboundMessages.recipientKey,
      createdAt: outboundMessages.createdAt,
      completedAt: outboundMessages.completedAt
    })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.organisationId, input.organisationId),
        eq(outboundMessages.channel, 'SMS'),
        eq(outboundMessages.source, 'TEST_SMS'),
        inArray(outboundMessages.status, ['ACCEPTED', 'DELIVERED']),
        gte(outboundMessages.createdAt, recentSmsSince),
        lte(outboundMessages.createdAt, input.now)
      )
    )
    .orderBy(
      desc(outboundMessages.completedAt),
      desc(outboundMessages.createdAt)
    );
  const activeResets = await database
    .select({ id: operationalResetRuns.id })
    .from(operationalResetRuns)
    .where(
      and(
        eq(operationalResetRuns.organisationId, input.organisationId),
        inArray(operationalResetRuns.status, activeResetStatuses)
      )
    )
    .limit(1);

  const providerEvidence = providers
    .filter(
      (
        provider
      ): provider is typeof provider & {
        connectedAt: Date;
        authenticatedAt: Date;
      } => provider.connectedAt !== null && provider.authenticatedAt !== null
    )
    .map((provider) => ({
      id: provider.id,
      provider: provider.provider,
      authenticatedAt: provider.authenticatedAt
    }));
  const providersHealthy = (['XERO', 'SINCH'] as const).every((provider) =>
    providerEvidence.some((evidence) => evidence.provider === provider)
  );
  const controlledMessage = recentTestMessages.find((message) => {
    const timestamp = message.completedAt ?? message.createdAt;
    return (
      organisation.recipientAllowlist.includes(message.recipientKey) &&
      timestamp.getTime() >= recentSmsSince.getTime() &&
      timestamp.getTime() <= input.now.getTime()
    );
  });
  const controlledSmsEvidence = controlledMessage
    ? {
        id: controlledMessage.id,
        status: controlledMessage.status as 'ACCEPTED' | 'DELIVERED',
        timestamp: controlledMessage.completedAt ?? controlledMessage.createdAt
      }
    : null;
  const [reconciliation] =
    organisation.lastSuccessfulSyncAt === null
      ? []
      : await database
          .select({
            id: rolloutReconciliations.id,
            syncCompletedAt: rolloutReconciliations.syncCompletedAt,
            acknowledgedAt: rolloutReconciliations.acknowledgedAt,
            activeContactCount: rolloutReconciliations.activeContactCount,
            outstandingInvoiceCount:
              rolloutReconciliations.outstandingInvoiceCount,
            outstandingTotals: rolloutReconciliations.outstandingTotals,
            generatedApprovalCount:
              rolloutReconciliations.generatedApprovalCount,
            enabledSequenceCount: rolloutReconciliations.enabledSequenceCount,
            allEnabledSequencesReview:
              rolloutReconciliations.allEnabledSequencesReview
          })
          .from(rolloutReconciliations)
          .where(
            and(
              eq(
                rolloutReconciliations.organisationId,
                input.organisationId
              ),
              eq(
                rolloutReconciliations.syncCompletedAt,
                organisation.lastSuccessfulSyncAt
              )
            )
          )
          .limit(1);
  const syncAge =
    organisation.lastSuccessfulSyncAt === null
      ? Number.POSITIVE_INFINITY
      : input.now.getTime() - organisation.lastSuccessfulSyncAt.getTime();
  const reconciliationMetricsCurrent =
    reconciliation !== undefined &&
    canonicalMetrics(metrics) ===
      canonicalMetrics({
        activeContactCount: reconciliation.activeContactCount,
        outstandingInvoiceCount: reconciliation.outstandingInvoiceCount,
        outstandingTotals: reconciliation.outstandingTotals,
        generatedApprovalCount: reconciliation.generatedApprovalCount,
        enabledSequenceCount: reconciliation.enabledSequenceCount,
        allEnabledSequencesReview: reconciliation.allEnabledSequencesReview
      });
  const reconciliationCurrent =
    reconciliation !== undefined &&
    reconciliationMetricsCurrent &&
    organisation.operationalState === 'RECONCILED' &&
    organisation.latestReconciledSyncAt?.getTime() ===
      organisation.lastSuccessfulSyncAt?.getTime();
  const resetState = [
    'RESET_PREPARING',
    'RESET_IN_PROGRESS',
    'RESET_FAILED'
  ].includes(organisation.operationalState);

  const gates: CustomerRolloutReadiness['gates'] = {
    controlledLive: {
      passed:
        organisation.sendMode === 'live' &&
        organisation.rolloutScope === 'CONTROLLED' &&
        organisation.liveSendAcknowledged,
      evidence: {
        sendMode: organisation.sendMode,
        rolloutScope: organisation.rolloutScope
      }
    },
    providersHealthy: {
      passed: providersHealthy,
      evidence: providerEvidence
    },
    syncFresh: {
      passed: syncAge >= 0 && syncAge <= 15 * 60_000,
      evidence: { timestamp: organisation.lastSuccessfulSyncAt }
    },
    importedDataPresent: {
      passed:
        metrics.activeContactCount > 0 && metrics.outstandingInvoiceCount > 0,
      evidence: {
        activeContactCount: metrics.activeContactCount,
        outstandingInvoiceCount: metrics.outstandingInvoiceCount
      }
    },
    controlledSmsEvidence: {
      passed: controlledSmsEvidence !== null,
      evidence: controlledSmsEvidence
    },
    resetIdle: {
      passed:
        !organisation.maintenanceMode && !resetState && activeResets.length === 0,
      evidence: { activeResetId: activeResets[0]?.id ?? null }
    },
    enabledSequencesReview: {
      passed: metrics.allEnabledSequencesReview,
      evidence: { enabledSequenceCount: metrics.enabledSequenceCount }
    },
    reconciliationCurrent: {
      passed: reconciliationCurrent,
      evidence:
        reconciliation === undefined
          ? null
          : {
              id: reconciliation.id,
              syncCompletedAt: reconciliation.syncCompletedAt,
              acknowledgedAt: reconciliation.acknowledgedAt
            }
    }
  };

  return {
    organisationId: input.organisationId,
    operationalState: organisation.operationalState,
    operationalStateVersion: organisation.operationalStateVersion,
    metrics,
    gates,
    readyForCustomerAcknowledgement: Object.values(gates).every(
      (gate) => gate.passed
    )
  };
}

export async function getCustomerRolloutReadiness(
  database: Database,
  input: { organisationId: string; now: Date }
): Promise<CustomerRolloutReadiness> {
  return calculateCustomerRolloutReadiness(database, input);
}

export function createSendingSettings(dependencies: {
  database: Database;
  clock: { now(): Date };
}) {
  const safety = new PostgresOrganisationSafetyRepository(
    dependencies.database
  );

  const updateAllowlist = async (
    session: AppSession,
    input: { organisationId: string; recipients: string[] }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    const normalised = [
      ...new Set(
        input.recipients
          .filter((value) => value.trim() !== '')
          .map(normaliseAllowlistRecipient)
      )
    ];
    const [before] = await dependencies.database
      .select({ recipientAllowlist: organisations.recipientAllowlist })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .limit(1);
    if (!before) throw new Error('ORGANISATION_NOT_FOUND');
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await transaction
        .update(organisations)
        .set({ recipientAllowlist: normalised, updatedAt: now })
        .where(eq(organisations.id, input.organisationId));
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'SEND_ALLOWLIST_UPDATED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        beforeValue: { count: before.recipientAllowlist.length },
        afterValue: { count: normalised.length },
        occurredAt: now
      });
    });
    return { recipients: normalised };
  };

  const activateLive = async (
    session: AppSession,
    input: {
      organisationId: string;
      acknowledgement: string;
      expectedVersion?: number;
    }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    if (input.acknowledgement !== LIVE_ACKNOWLEDGEMENT) {
      throw new Error('ACKNOWLEDGEMENT_MISMATCH');
    }
    await dependencies.database.transaction(async (transaction) => {
      const organisation = await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      if (organisation.rolloutScope === 'CUSTOMER') {
        throw new Error('CUSTOMER_ROLLOUT_REQUIRES_REASONED_ROLLBACK');
      }
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== organisation.operationalStateVersion
      ) {
        throw new Error('OPERATIONAL_STATE_CONFLICT');
      }
      const now = dependencies.clock.now();
      const healthySince = new Date(now.getTime() - 24 * 60 * 60_000);
      const providers = await transaction
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.organisationId, input.organisationId),
            eq(providerConnections.enabled, true),
            gte(
              providerConnections.lastSuccessfulAuthenticationAt,
              healthySince
            ),
            lte(providerConnections.lastSuccessfulAuthenticationAt, now)
          )
        );
      if (
        !(['XERO', 'SINCH'] as const).every((provider) =>
          providers.some(
            (connection) =>
              connection.provider === provider && connection.connectedAt !== null
          )
        )
      ) {
        throw new Error('PROVIDERS_UNHEALTHY');
      }
      if (
        organisation.lastSuccessfulSyncAt === null ||
        now.getTime() - organisation.lastSuccessfulSyncAt.getTime() < 0 ||
        now.getTime() - organisation.lastSuccessfulSyncAt.getTime() > 15 * 60_000
      ) {
        throw new Error('XERO_SYNC_STALE');
      }
      if (organisation.recipientAllowlist.length === 0) {
        throw new Error('ALLOWLIST_REQUIRED');
      }
      await safety.compareAndSetOperationalState(transaction, {
        organisationId: input.organisationId,
        expectedState: organisation.operationalState,
        expectedVersion: organisation.operationalStateVersion,
        nextState: organisation.operationalState,
        rolloutScope: 'CONTROLLED',
        sendMode: 'live',
        liveSendAcknowledged: true,
        now
      });
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'LIVE_SENDING_ACTIVATED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        beforeValue: {
          sendMode: organisation.sendMode,
          rolloutScope: organisation.rolloutScope
        },
        afterValue: { sendMode: 'live', rolloutScope: 'CONTROLLED' },
        occurredAt: now
      });
    });
  };

  const acknowledgeReconciliation = async (
    session: AppSession,
    input: {
      organisationId: string;
      acknowledgement: string;
      expectedVersion: number;
      expected: {
        syncCompletedAt: string;
        metrics: ReconciliationMetrics;
      };
    }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    if (input.acknowledgement !== RECONCILIATION_ACKNOWLEDGEMENT) {
      throw new Error('RECONCILIATION_ACKNOWLEDGEMENT_MISMATCH');
    }
    return dependencies.database.transaction(async (transaction) => {
      const organisation = await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      const now = dependencies.clock.now();
      if (
        organisation.operationalState !== 'RECONCILIATION_REQUIRED' ||
        organisation.operationalStateVersion !== input.expectedVersion
      ) {
        throw new Error('OPERATIONAL_STATE_CONFLICT');
      }
      if (
        !sameTimestamp(
          organisation.lastSuccessfulSyncAt,
          input.expected.syncCompletedAt
        )
      ) {
        throw new Error('SYNC_SUPERSEDED');
      }
      const metrics = await getReconciliationMetrics(
        transaction,
        input.organisationId
      );
      if (canonicalMetrics(metrics) !== canonicalMetrics(input.expected.metrics)) {
        throw new Error('RECONCILIATION_METRICS_CHANGED');
      }
      if (organisation.lastSuccessfulSyncAt === null) {
        throw new Error('SYNC_REQUIRED');
      }
      const [reconciliation] = await transaction
        .insert(rolloutReconciliations)
        .values({
          organisationId: input.organisationId,
          syncCompletedAt: organisation.lastSuccessfulSyncAt,
          ...metrics,
          acknowledgedByUserId: session.userId,
          acknowledgedAt: now
        })
        .returning({ id: rolloutReconciliations.id });
      if (!reconciliation) throw new Error('RECONCILIATION_NOT_RECORDED');
      await safety.compareAndSetOperationalState(transaction, {
        organisationId: input.organisationId,
        expectedState: 'RECONCILIATION_REQUIRED',
        expectedVersion: input.expectedVersion,
        nextState: 'RECONCILED',
        now
      });
      await transaction
        .update(organisations)
        .set({ latestReconciledSyncAt: organisation.lastSuccessfulSyncAt })
        .where(eq(organisations.id, input.organisationId));
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'ROLLOUT_RECONCILIATION_ACKNOWLEDGED',
        entityType: 'ROLLOUT_RECONCILIATION',
        entityId: reconciliation.id,
        afterValue: {
          syncCompletedAt: organisation.lastSuccessfulSyncAt.toISOString(),
          ...metrics
        },
        occurredAt: now
      });
      return { reconciliationId: reconciliation.id };
    });
  };

  const activateCustomerRollout = async (
    session: AppSession,
    input: {
      organisationId: string;
      acknowledgement: string;
      expectedVersion: number;
    }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    if (input.acknowledgement !== CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT) {
      throw new Error('CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT_MISMATCH');
    }
    return dependencies.database.transaction(async (transaction) => {
      const organisation = await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      if (
        organisation.operationalState !== 'RECONCILED' ||
        organisation.operationalStateVersion !== input.expectedVersion
      ) {
        throw new Error('OPERATIONAL_STATE_CONFLICT');
      }
      await lockCustomerRolloutEvidence(transaction, input.organisationId);
      const readinessTime = dependencies.clock.now();
      const readiness = await calculateCustomerRolloutReadiness(transaction, {
        organisationId: input.organisationId,
        now: readinessTime
      });
      const now = dependencies.clock.now();
      const failed = failedReadinessGatesAt(readiness, now);
      if (failed.length > 0) {
        throw new Error(`CUSTOMER_ROLLOUT_NOT_READY:${failed.join(',')}`);
      }
      const updated = await safety.compareAndSetOperationalState(transaction, {
        organisationId: input.organisationId,
        expectedState: 'RECONCILED',
        expectedVersion: input.expectedVersion,
        nextState: 'RECONCILED',
        rolloutScope: 'CUSTOMER',
        sendMode: 'live',
        liveSendAcknowledged: true,
        now
      });
      const smsEvidence = readiness.gates.controlledSmsEvidence.evidence;
      if (!smsEvidence || !organisation.lastSuccessfulSyncAt) {
        throw new Error('CUSTOMER_ROLLOUT_EVIDENCE_MISSING');
      }
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'CUSTOMER_ROLLOUT_ACTIVATED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        beforeValue: { rolloutScope: organisation.rolloutScope },
        afterValue: {
          beforeScope: organisation.rolloutScope,
          afterScope: updated.rolloutScope,
          syncCompletedAt: organisation.lastSuccessfulSyncAt.toISOString(),
          controlledSmsEvidenceId: smsEvidence.id,
          enabledSequenceCount: readiness.metrics.enabledSequenceCount
        },
        occurredAt: now
      });
      return readiness;
    });
  };

  const overrideCustomerRollout = async (
    session: AppSession,
    input: {
      organisationId: string;
      acknowledgement: string;
      reason: string;
      expectedVersion: number;
    }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    if (input.acknowledgement !== CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT) {
      throw new Error('CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT_MISMATCH');
    }
    requiredReason(input.reason);
    return dependencies.database.transaction(async (transaction) => {
      const organisation = await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      if (organisation.operationalStateVersion !== input.expectedVersion) {
        throw new Error('OPERATIONAL_STATE_CONFLICT');
      }
      if (organisation.rolloutScope === 'CUSTOMER') {
        throw new Error('ROLLOUT_STATE_CONFLICT');
      }
      await lockCustomerRolloutEvidence(transaction, input.organisationId);
      const now = dependencies.clock.now();
      const readiness = await calculateCustomerRolloutReadiness(transaction, {
        organisationId: input.organisationId,
        now
      });
      if (
        !readiness.gates.resetIdle.passed ||
        organisation.operationalState === 'RESET_PREPARING' ||
        organisation.operationalState === 'RESET_IN_PROGRESS' ||
        organisation.operationalState === 'RESET_FAILED'
      ) {
        throw new Error('OPERATIONAL_MAINTENANCE');
      }
      const bypassedGates = failedReadinessGatesAt(readiness, now).filter(
        (gate) => gate !== 'resetIdle'
      );
      const updated = await safety.compareAndSetOperationalState(transaction, {
        organisationId: input.organisationId,
        expectedState: organisation.operationalState,
        expectedVersion: input.expectedVersion,
        nextState: organisation.operationalState,
        rolloutScope: 'CUSTOMER',
        sendMode: 'live',
        liveSendAcknowledged: true,
        now
      });
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'CUSTOMER_ROLLOUT_SETUP_OVERRIDE_ACTIVATED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        beforeValue: {
          rolloutScope: organisation.rolloutScope,
          sendMode: organisation.sendMode,
          operationalState: organisation.operationalState
        },
        afterValue: {
          beforeScope: organisation.rolloutScope,
          afterScope: updated.rolloutScope,
          sendMode: updated.sendMode,
          operationalState: updated.operationalState,
          reasonRecorded: true,
          bypassedGates
        },
        occurredAt: now
      });
      return { readiness, bypassedGates };
    });
  };

  const returnToControlledLive = async (
    session: AppSession,
    input: {
      organisationId: string;
      reason: string;
      expectedVersion: number;
    }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    requiredReason(input.reason);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      const [organisation] = await transaction
        .select()
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .for('update')
        .limit(1);
      if (!organisation) throw new Error('ORGANISATION_NOT_FOUND');
      if (organisation.operationalStateVersion !== input.expectedVersion) {
        throw new Error('OPERATIONAL_STATE_CONFLICT');
      }
      if (
        organisation.sendMode !== 'live' ||
        organisation.rolloutScope !== 'CUSTOMER'
      ) {
        throw new Error('ROLLOUT_STATE_CONFLICT');
      }
      await safety.compareAndSetOperationalState(transaction, {
        organisationId: input.organisationId,
        expectedState: organisation.operationalState,
        expectedVersion: input.expectedVersion,
        nextState: organisation.operationalState,
        rolloutScope: 'CONTROLLED',
        sendMode: 'live',
        liveSendAcknowledged: organisation.liveSendAcknowledged,
        now
      });
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'CUSTOMER_ROLLOUT_RETURNED_TO_CONTROLLED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        beforeValue: { rolloutScope: 'CUSTOMER' },
        afterValue: {
          rolloutScope: 'CONTROLLED',
          sendMode: 'live',
          reasonProvided: true
        },
        occurredAt: now
      });
    });
  };

  const disableAllProviderSending = async (
    session: AppSession,
    input: {
      organisationId: string;
      reason: string;
      expectedVersion: number;
    }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    requiredReason(input.reason);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      const [organisation] = await transaction
        .select()
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .for('update')
        .limit(1);
      if (!organisation) throw new Error('ORGANISATION_NOT_FOUND');
      if (organisation.operationalStateVersion !== input.expectedVersion) {
        throw new Error('OPERATIONAL_STATE_CONFLICT');
      }
      await safety.compareAndSetOperationalState(transaction, {
        organisationId: input.organisationId,
        expectedState: organisation.operationalState,
        expectedVersion: input.expectedVersion,
        nextState: organisation.operationalState,
        rolloutScope: 'CONTROLLED',
        sendMode: 'dry-run',
        liveSendAcknowledged: false,
        now
      });
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'ALL_PROVIDER_SENDING_DISABLED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        beforeValue: {
          sendMode: organisation.sendMode,
          rolloutScope: organisation.rolloutScope
        },
        afterValue: {
          sendMode: 'dry-run',
          rolloutScope: 'CONTROLLED',
          reasonProvided: true
        },
        occurredAt: now
      });
    });
  };

  const disableLive = async (
    session: AppSession,
    input: {
      organisationId: string;
      reason: string;
      expectedVersion?: number;
    }
  ) => {
    authorise(session, 'provider.configure', input.organisationId);
    requiredReason(input.reason);
    const [organisation] = await dependencies.database
      .select({ version: organisations.operationalStateVersion })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .limit(1);
    if (!organisation) throw new Error('ORGANISATION_NOT_FOUND');
    return disableAllProviderSending(session, {
      organisationId: input.organisationId,
      reason: input.reason,
      expectedVersion: input.expectedVersion ?? organisation.version
    });
  };

  return {
    updateAllowlist,
    activateLive,
    acknowledgeReconciliation,
    activateCustomerRollout,
    overrideCustomerRollout,
    returnToControlledLive,
    disableAllProviderSending,
    disableLive
  };
}
