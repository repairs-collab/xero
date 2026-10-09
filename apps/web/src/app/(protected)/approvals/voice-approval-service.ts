import { and, eq } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  approvedVoiceFactsFromStoredCall,
  auditEvents,
  buildApprovedVoiceFactsHash,
  createVoicePreparationService,
  type Database,
  PostgresOrganisationSafetyRepository,
  type PostgresVoiceCallRepository,
  voiceCallRequests
} from '@bc5000/db/web';

export class StaleVoiceApproval extends Error {
  readonly code = 'VOICE_APPROVAL_STALE';

  constructor() {
    super('VOICE_APPROVAL_STALE');
    this.name = 'StaleVoiceApproval';
  }
}

export interface VoiceApprovalServiceDependencies {
  database: Database;
  repository: PostgresVoiceCallRepository;
  clock: { now(): Date };
  holidays: { list(organisationId: string): readonly string[] };
}

interface VoiceApprovalInput {
  organisationId: string;
  voiceCallId: string;
}

export function createVoiceApprovalService(
  dependencies: VoiceApprovalServiceDependencies
) {
  const safety = new PostgresOrganisationSafetyRepository(
    dependencies.database
  );
  const preparation = createVoicePreparationService({
    database: dependencies.database,
    repository: dependencies.repository,
    clock: dependencies.clock,
    holidays: dependencies.holidays
  });

  const cancelStale = async (
    session: AppSession,
    input: VoiceApprovalInput,
    safeCode: string
  ): Promise<void> => {
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      const [cancelled] = await transaction
        .update(voiceCallRequests)
        .set({
          actorUserId: session.userId,
          state: 'CANCELLED',
          failureCode: 'STALE_ACCOUNT_DATA',
          completedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, input.voiceCallId),
            eq(voiceCallRequests.source, 'SEQUENCE_REVIEW'),
            eq(voiceCallRequests.state, 'DRAFT')
          )
        )
        .returning({ id: voiceCallRequests.id });
      if (cancelled === undefined) throw new Error('VOICE_APPROVAL_NOT_PENDING');
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'VOICE_APPROVAL_EXPIRED_STALE',
        entityType: 'VOICE_CALL',
        entityId: input.voiceCallId,
        afterValue: { state: 'CANCELLED', safeCode },
        occurredAt: now
      });
    });
  };

  const approve = async (
    session: AppSession,
    input: VoiceApprovalInput
  ): Promise<{ voiceCallId: string }> => {
    authorise(session, 'reminder.approve', input.organisationId);
    await dependencies.database.transaction((transaction) =>
      safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      )
    );
    const draft = await dependencies.repository.loadForExecution(
      input.organisationId,
      input.voiceCallId
    );
    if (
      draft === null ||
      draft.source !== 'SEQUENCE_REVIEW' ||
      draft.state !== 'DRAFT' ||
      draft.sequenceId === null ||
      draft.sequenceVersionId === null ||
      draft.stageKey === null ||
      draft.scheduledAt === null ||
      draft.localOccurrenceDate === null
    ) {
      throw new Error('VOICE_APPROVAL_NOT_PENDING');
    }
    const current = await preparation.evaluate({
      organisationId: input.organisationId,
      customerId: draft.contactId,
      actorUserId: session.userId,
      idempotencyKey: draft.idempotencyKey,
      initialState: 'DRAFT',
      source: {
        kind: 'SEQUENCE_REVIEW',
        sequenceId: draft.sequenceId,
        sequenceVersionId: draft.sequenceVersionId,
        stageKey: draft.stageKey,
        scheduledAt: draft.scheduledAt,
        localOccurrenceDate: draft.localOccurrenceDate
      },
      invoiceIds: draft.invoices.map((invoice) => invoice.invoiceId)
    });
    const storedFacts = approvedVoiceFactsFromStoredCall(draft);
    const staleCode =
      !current.allowed ||
      current.approvedFactsHash === null ||
      storedFacts === null ||
      buildApprovedVoiceFactsHash(storedFacts) !== current.approvedFactsHash
        ? (current.blockCode ?? 'STALE_ACCOUNT_DATA')
        : null;
    if (staleCode !== null) {
      await cancelStale(session, input, staleCode);
      throw new StaleVoiceApproval();
    }

    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      const [approved] = await transaction
        .update(voiceCallRequests)
        .set({
          actorUserId: session.userId,
          state: 'APPROVED',
          callFlowVersion: current.callFlowVersion,
          callFlowHash: current.callFlowHash,
          approvedFactsHash: current.approvedFactsHash,
          approvedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, input.voiceCallId),
            eq(voiceCallRequests.source, 'SEQUENCE_REVIEW'),
            eq(voiceCallRequests.state, 'DRAFT')
          )
        )
        .returning({ id: voiceCallRequests.id });
      if (approved === undefined) throw new Error('VOICE_APPROVAL_NOT_PENDING');
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'VOICE_REMINDER_APPROVED',
        entityType: 'VOICE_CALL',
        entityId: input.voiceCallId,
        correlationId: draft.idempotencyKey,
        afterValue: {
          state: 'APPROVED',
          invoiceCount: draft.invoices.length,
          callFlowVersion: current.callFlowVersion
        },
        occurredAt: now
      });
    });
    return { voiceCallId: input.voiceCallId };
  };

  const reject = async (
    session: AppSession,
    input: VoiceApprovalInput
  ): Promise<{ voiceCallId: string }> => {
    authorise(session, 'reminder.approve', input.organisationId);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      await safety.assertOperationalMutationAllowed(
        transaction,
        input.organisationId
      );
      const [rejected] = await transaction
        .update(voiceCallRequests)
        .set({
          actorUserId: session.userId,
          state: 'CANCELLED',
          failureCode: 'OPERATOR_REJECTED',
          completedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, input.voiceCallId),
            eq(voiceCallRequests.source, 'SEQUENCE_REVIEW'),
            eq(voiceCallRequests.state, 'DRAFT')
          )
        )
        .returning({ id: voiceCallRequests.id });
      if (rejected === undefined) throw new Error('VOICE_APPROVAL_NOT_PENDING');
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'VOICE_REMINDER_REJECTED',
        entityType: 'VOICE_CALL',
        entityId: input.voiceCallId,
        afterValue: { state: 'CANCELLED' },
        occurredAt: now
      });
    });
    return { voiceCallId: input.voiceCallId };
  };

  const bulkApprove = async (
    session: AppSession,
    input: { organisationId: string; voiceCallIds: string[] }
  ) => {
    const results: Array<{
      voiceCallId: string;
      status: 'APPROVED' | 'STALE' | 'FAILED';
      reason?: string;
    }> = [];
    for (const voiceCallId of input.voiceCallIds) {
      try {
        await approve(session, {
          organisationId: input.organisationId,
          voiceCallId
        });
        results.push({ voiceCallId, status: 'APPROVED' });
      } catch (error) {
        if (error instanceof StaleVoiceApproval) {
          results.push({ voiceCallId, status: 'STALE' });
        } else {
          results.push({
            voiceCallId,
            status: 'FAILED',
            reason: error instanceof Error ? error.message : 'UNKNOWN'
          });
        }
      }
    }
    return results;
  };

  return { approve, reject, bulkApprove };
}
