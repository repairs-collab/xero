import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import {
  approvals,
  auditEvents,
  contacts,
  type Database,
  invoiceChases,
  invoices,
  organisations,
  outboundMessages,
  PostgresOrganisationSafetyRepository,
  reminderSequenceVersions,
  reminderWhitelistEntries,
  sequenceStages,
  stageInstances
} from '@bc5000/db';
import { localDateInterval } from '@bc5000/domain';

import { renderReminderPreview } from '../handlers/reminders-calculate.js';

export const approvedSmsRecoveryAcknowledgement = (localDate: string): string =>
  `RECOVER APPROVED UNSENT SMS FOR ${localDate}`;

interface ApprovedSmsRecoveryDependencies {
  database: Database;
  clock: { now(): Date };
}

type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];
type RecoveryQueryExecutor = Pick<DatabaseTransaction, 'select'>;

interface RecoveryCandidate {
  approvalId: string;
  currentSourceVersion: number;
  decidedByUserId: string;
  renderedPreview: string;
  stageInstanceId: string;
  stageSourceVersion: number;
}

export interface ApprovedSmsRecoveryPreview {
  localDate: string;
  count: number;
  digest: string;
  stageInstanceIds: string[];
}

const requireCustomerLive = async (
  executor: RecoveryQueryExecutor,
  organisationId: string
) => {
  const [organisation] = await executor
    .select()
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
  if (
    organisation.sendMode !== 'live' ||
    organisation.rolloutScope !== 'CUSTOMER' ||
    !organisation.liveSendAcknowledged
  ) {
    throw new Error('CUSTOMER_LIVE_REQUIRED');
  }
  if (organisation.maintenanceMode) {
    throw new Error('OPERATIONAL_MAINTENANCE');
  }
  return organisation;
};

const digestCandidates = (candidates: RecoveryCandidate[]): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        candidates.map((candidate) => ({
          approvalId: candidate.approvalId,
          currentSourceVersion: candidate.currentSourceVersion,
          previewDigest: createHash('sha256')
            .update(candidate.renderedPreview)
            .digest('hex'),
          stageInstanceId: candidate.stageInstanceId,
          stageSourceVersion: candidate.stageSourceVersion
        }))
      )
    )
    .digest('hex');

const findCandidates = async (
  executor: RecoveryQueryExecutor,
  input: { organisationId: string; localDate: string },
  lockRows: boolean
): Promise<RecoveryCandidate[]> => {
  const organisation = await requireCustomerLive(
    executor,
    input.organisationId
  );
  const interval = localDateInterval(input.localDate, organisation.timeZone);
  const query = executor
    .select({
      approvalId: approvals.id,
      approvalCreatedAt: approvals.createdAt,
      approvalStatus: approvals.status,
      amountDue: invoices.amountDue,
      currency: invoices.currency,
      currentSourceVersion: invoices.syncVersion,
      contactId: contacts.id,
      customerName: contacts.name,
      decidedAt: approvals.decidedAt,
      decidedByUserId: approvals.decidedByUserId,
      dueDate: invoices.dueDate,
      invoiceNumber: invoices.invoiceNumber,
      invoiceId: invoices.id,
      maxSmsSegments: reminderSequenceVersions.maxSmsSegments,
      onlineInvoiceUrl: invoices.onlineInvoiceUrl,
      sequenceVersionId: stageInstances.sequenceVersionId,
      stageInstanceId: stageInstances.id,
      stageKey: stageInstances.stageKey,
      stageSourceVersion: stageInstances.sourceVersion
    })
    .from(stageInstances)
    .innerJoin(
      approvals,
      and(
        eq(approvals.organisationId, input.organisationId),
        eq(approvals.stageInstanceId, stageInstances.id)
      )
    )
    .innerJoin(
      invoiceChases,
      and(
        eq(invoiceChases.organisationId, input.organisationId),
        eq(invoiceChases.id, stageInstances.invoiceChaseId)
      )
    )
    .innerJoin(
      invoices,
      and(
        eq(invoices.organisationId, input.organisationId),
        eq(invoices.id, invoiceChases.invoiceId)
      )
    )
    .innerJoin(
      contacts,
      and(
        eq(contacts.organisationId, input.organisationId),
        eq(contacts.id, invoices.contactId)
      )
    )
    .innerJoin(
      reminderSequenceVersions,
      and(
        eq(reminderSequenceVersions.organisationId, input.organisationId),
        eq(reminderSequenceVersions.id, stageInstances.sequenceVersionId)
      )
    )
    .where(
      and(
        eq(stageInstances.organisationId, input.organisationId),
        eq(stageInstances.status, 'CANCELLED'),
        eq(stageInstances.channel, 'SMS'),
        eq(stageInstances.origin, 'AUTOMATION')
      )
    )
    .orderBy(desc(approvals.createdAt), desc(approvals.id));
  const rows = lockRows ? await query.for('update') : await query;

  const latestByStage = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByStage.has(row.stageInstanceId)) {
      latestByStage.set(row.stageInstanceId, row);
    }
  }
  const possible = [...latestByStage.values()].filter(
    (row): row is typeof row & {
      decidedAt: Date;
      decidedByUserId: string;
    } =>
      row.approvalStatus === 'EXPIRED' &&
      row.decidedAt !== null &&
      row.decidedByUserId !== null &&
      row.decidedAt >= interval.from &&
      row.decidedAt < interval.before
  );
  if (possible.length === 0) return [];

  const stageIds = possible.map((row) => row.stageInstanceId);
  const outbound = await executor
    .select({ stageInstanceId: outboundMessages.stageInstanceId })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.organisationId, input.organisationId),
        inArray(outboundMessages.stageInstanceId, stageIds)
      )
    );
  const configuredStages = await executor
    .select({
      channel: sequenceStages.channel,
      sequenceVersionId: sequenceStages.sequenceVersionId,
      stageKey: sequenceStages.stageKey,
      template: sequenceStages.template
    })
    .from(sequenceStages)
    .where(
      and(
        eq(sequenceStages.organisationId, input.organisationId),
        eq(sequenceStages.enabled, true),
        inArray(
          sequenceStages.sequenceVersionId,
          possible.map((row) => row.sequenceVersionId)
        )
      )
    )
    .orderBy(sequenceStages.id);
  const whitelistEntries = await executor
    .select({
      contactId: reminderWhitelistEntries.contactId,
      invoiceId: reminderWhitelistEntries.invoiceId,
      scope: reminderWhitelistEntries.scope
    })
    .from(reminderWhitelistEntries)
    .where(
      and(
        eq(reminderWhitelistEntries.organisationId, input.organisationId),
        isNull(reminderWhitelistEntries.removedAt),
        or(
          and(
            eq(reminderWhitelistEntries.scope, 'CLIENT'),
            inArray(
              reminderWhitelistEntries.contactId,
              possible.map((row) => row.contactId)
            )
          ),
          and(
            eq(reminderWhitelistEntries.scope, 'INVOICE'),
            inArray(
              reminderWhitelistEntries.invoiceId,
              possible.map((row) => row.invoiceId)
            )
          )
        )
      )
    );
  const alreadyRecorded = new Set(
    outbound.flatMap((row) =>
      row.stageInstanceId === null ? [] : [row.stageInstanceId]
    )
  );

  return possible
    .filter((row) => !alreadyRecorded.has(row.stageInstanceId))
    .filter(
      (row) =>
        !whitelistEntries.some((entry) =>
          entry.scope === 'CLIENT'
            ? entry.contactId === row.contactId
            : entry.invoiceId === row.invoiceId
        )
    )
    .map((row) => {
      const configured = configuredStages.find(
        (stage) =>
          stage.sequenceVersionId === row.sequenceVersionId &&
          ((row.stageKey === 'daily-after-30' &&
            stage.channel === 'SMS_DAILY') ||
            (stage.stageKey === row.stageKey && stage.channel === 'SMS'))
      );
      if (configured === undefined) {
        throw new Error(
          `RECOVERY_STAGE_CONFIGURATION_NOT_FOUND:${row.stageInstanceId}`
        );
      }
      return {
        approvalId: row.approvalId,
        currentSourceVersion: row.currentSourceVersion,
        decidedByUserId: row.decidedByUserId,
        renderedPreview: renderReminderPreview({
          channel: 'SMS',
          template: configured.template,
          customerName: row.customerName,
          invoiceNumber: row.invoiceNumber,
          amountDue: row.amountDue,
          currency: row.currency,
          dueDate: row.dueDate,
          onlineInvoiceUrl: row.onlineInvoiceUrl,
          organisationName: organisation.name,
          maxSmsSegments: row.maxSmsSegments
        }),
        stageInstanceId: row.stageInstanceId,
        stageSourceVersion: row.stageSourceVersion
      };
    })
    .sort((left, right) =>
      left.stageInstanceId.localeCompare(right.stageInstanceId)
    );
};

export function createApprovedSmsRecoveryService(
  dependencies: ApprovedSmsRecoveryDependencies
) {
  const preview = async (input: {
    organisationId: string;
    localDate: string;
  }): Promise<ApprovedSmsRecoveryPreview> => {
    const candidates = await findCandidates(
      dependencies.database,
      input,
      false
    );
    return {
      localDate: input.localDate,
      count: candidates.length,
      digest: digestCandidates(candidates),
      stageInstanceIds: candidates.map((candidate) => candidate.stageInstanceId)
    };
  };

  const execute = async (input: {
    organisationId: string;
    localDate: string;
    expectedCount: number;
    expectedDigest: string;
    acknowledgement: string;
  }): Promise<{ regeneratedCount: number }> => {
    if (
      input.acknowledgement !==
      approvedSmsRecoveryAcknowledgement(input.localDate)
    ) {
      throw new Error('RECOVERY_ACKNOWLEDGEMENT_MISMATCH');
    }
    if (!Number.isSafeInteger(input.expectedCount) || input.expectedCount < 0) {
      throw new Error('RECOVERY_EXPECTED_COUNT_INVALID');
    }
    if (!/^[0-9a-f]{64}$/.test(input.expectedDigest)) {
      throw new Error('RECOVERY_EXPECTED_DIGEST_INVALID');
    }

    return dependencies.database.transaction(async (transaction) => {
      const organisation =
        await new PostgresOrganisationSafetyRepository(
          dependencies.database
        ).assertOperationalMutationAllowed(transaction, input.organisationId);
      if (
        organisation.sendMode !== 'live' ||
        organisation.rolloutScope !== 'CUSTOMER' ||
        !organisation.liveSendAcknowledged
      ) {
        throw new Error('CUSTOMER_LIVE_REQUIRED');
      }

      const candidates = await findCandidates(transaction, input, true);
      if (candidates.length !== input.expectedCount) {
        throw new Error(
          `RECOVERY_COUNT_CHANGED: expected ${input.expectedCount.toString()}, found ${candidates.length.toString()}`
        );
      }
      if (digestCandidates(candidates) !== input.expectedDigest) {
        throw new Error('RECOVERY_PREVIEW_CHANGED');
      }
      if (candidates.length === 0) return { regeneratedCount: 0 };

      const now = dependencies.clock.now();
      for (const candidate of candidates) {
        const updatedStages = await transaction
          .update(stageInstances)
          .set({
            status: 'AWAITING_APPROVAL',
            sourceVersion: candidate.currentSourceVersion,
            completedAt: null,
            updatedAt: now
          })
          .where(
            and(
              eq(stageInstances.organisationId, input.organisationId),
              eq(stageInstances.id, candidate.stageInstanceId),
              eq(stageInstances.status, 'CANCELLED'),
              eq(stageInstances.sourceVersion, candidate.stageSourceVersion)
            )
          )
          .returning({ id: stageInstances.id });
        if (updatedStages.length !== 1) {
          throw new Error('RECOVERY_CANDIDATES_CHANGED');
        }
        await transaction.insert(approvals).values({
          organisationId: input.organisationId,
          stageInstanceId: candidate.stageInstanceId,
          renderedPreview: candidate.renderedPreview,
          sourceVersion: candidate.currentSourceVersion,
          status: 'PENDING',
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
        });
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: candidate.decidedByUserId,
          eventType: 'APPROVED_SMS_RECOVERY_REGENERATED',
          entityType: 'STAGE_INSTANCE',
          entityId: candidate.stageInstanceId,
          correlationId: `approved-sms-recovery:${input.localDate}`,
          beforeValue: {
            status: 'CANCELLED',
            approvalStatus: 'EXPIRED',
            sourceVersion: candidate.stageSourceVersion
          },
          afterValue: {
            status: 'AWAITING_APPROVAL',
            approvalStatus: 'PENDING',
            sourceVersion: candidate.currentSourceVersion
          },
          occurredAt: now
        });
      }
      return { regeneratedCount: candidates.length };
    });
  };

  return { execute, preview };
}
