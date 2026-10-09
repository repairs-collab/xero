import { authorise, type AppSession } from '@bc5000/auth';
import {
  approvedVoiceFactsFromStoredCall,
  auditEvents,
  buildApprovedVoiceFactsHash,
  createVoicePreparationService,
  type ApprovedVoiceFacts,
  type ApprovedVoiceInvoiceFact,
  type Database,
  type PostgresVoiceCallRepository,
  type VoiceCallDraftView
} from '@bc5000/db/web';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export { buildApprovedVoiceFactsHash };
export type {
  ApprovedVoiceFacts,
  ApprovedVoiceInvoiceFact,
  VoiceCallDraftView
};

export interface PrepareVoiceCallInput {
  organisationId: string;
  customerId: string;
  idempotencyKey: string;
}

export interface ApproveAndQueueVoiceCallInput
  extends PrepareVoiceCallInput {
  voiceCallId: string;
  callFlowVersion: number;
  callFlowHash: string;
  approvedFactsHash: string;
  confirmed: boolean;
}

export interface VoiceCallServiceDependencies {
  database: Database;
  repository: PostgresVoiceCallRepository;
  publisher: JobPublisher;
  session: AppSession;
  clock: { now(): Date };
  holidays: { list(organisationId: string): readonly string[] };
}

export function createVoiceCallService(
  dependencies: VoiceCallServiceDependencies
) {
  const preparation = createVoicePreparationService({
    database: dependencies.database,
    repository: dependencies.repository,
    clock: dependencies.clock,
    holidays: dependencies.holidays
  });

  const preparationInput = (input: PrepareVoiceCallInput) => ({
    organisationId: input.organisationId,
    customerId: input.customerId,
    actorUserId: dependencies.session.userId,
    idempotencyKey: input.idempotencyKey,
    initialState: 'DRAFT' as const,
    source: { kind: 'MANUAL' as const }
  });

  const prepare = async (
    input: PrepareVoiceCallInput
  ): Promise<VoiceCallDraftView> => {
    authorise(dependencies.session, 'voice-call.prepare', input.organisationId);
    return preparation.create(preparationInput(input));
  };

  const approveAndQueue = async (
    input: ApproveAndQueueVoiceCallInput
  ): Promise<{ voiceCallId: string; created: boolean }> => {
    authorise(dependencies.session, 'voice-call.place', input.organisationId);
    if (!input.confirmed) throw new Error('VOICE_CALL_CONFIRMATION_REQUIRED');
    const draft = await dependencies.repository.loadForExecution(
      input.organisationId,
      input.voiceCallId
    );
    if (
      draft === null ||
      draft.source !== 'MANUAL' ||
      draft.contactId !== input.customerId ||
      draft.idempotencyKey !== input.idempotencyKey
    ) {
      throw new Error('VOICE_CALL_APPROVAL_MISMATCH');
    }
    if (draft.state !== 'DRAFT') {
      const repeated = await dependencies.repository.approveAndQueue({
        organisationId: input.organisationId,
        voiceCallId: input.voiceCallId,
        actorUserId: dependencies.session.userId,
        idempotencyKey: input.idempotencyKey,
        callFlowVersion: input.callFlowVersion,
        callFlowHash: input.callFlowHash,
        approvedFactsHash: input.approvedFactsHash,
        now: dependencies.clock.now()
      });
      await dependencies.publisher.publish(
        jobNames.voiceCallExecute,
        {
          organisationId: input.organisationId,
          voiceCallId: input.voiceCallId,
          provider: 'VOIPCLOUD'
        },
        { singletonKey: `voice-call:${input.voiceCallId}` }
      );
      return repeated;
    }

    const current = await preparation.evaluate(preparationInput(input));
    if (!current.allowed) {
      throw new Error(current.blockCode ?? 'VOICE_CALL_NOT_ALLOWED');
    }
    if (
      current.approvedFacts === null ||
      current.approvedFactsHash === null ||
      input.callFlowVersion !== current.callFlowVersion ||
      input.callFlowHash !== current.callFlowHash ||
      input.approvedFactsHash !== current.approvedFactsHash
    ) {
      throw new Error('STALE_ACCOUNT_DATA');
    }
    const draftFacts = approvedVoiceFactsFromStoredCall(draft);
    if (
      draftFacts === null ||
      buildApprovedVoiceFactsHash(draftFacts) !== input.approvedFactsHash
    ) {
      throw new Error('STALE_ACCOUNT_DATA');
    }

    const approved = await dependencies.repository.approveAndQueue({
      organisationId: input.organisationId,
      voiceCallId: input.voiceCallId,
      actorUserId: dependencies.session.userId,
      idempotencyKey: input.idempotencyKey,
      callFlowVersion: input.callFlowVersion,
      callFlowHash: input.callFlowHash,
      approvedFactsHash: input.approvedFactsHash,
      now: dependencies.clock.now()
    });
    if (approved.created) {
      await dependencies.database.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: dependencies.session.userId,
        eventType: 'VOICE_CALL_FACTS_APPROVED',
        entityType: 'VOICE_CALL',
        entityId: input.voiceCallId,
        correlationId: input.idempotencyKey,
        afterValue: {
          state: 'QUEUED',
          invoiceCount: draft.invoices.length,
          callFlowVersion: input.callFlowVersion
        },
        occurredAt: dependencies.clock.now()
      });
    }
    await dependencies.publisher.publish(
      jobNames.voiceCallExecute,
      {
        organisationId: input.organisationId,
        voiceCallId: input.voiceCallId,
        provider: 'VOIPCLOUD'
      },
      { singletonKey: `voice-call:${input.voiceCallId}` }
    );
    return approved;
  };

  return { prepare, approveAndQueue };
}
