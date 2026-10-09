import type {
  VoiceCallOperationalState,
  VoiceCallOutcome
} from '@bc5000/domain';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  sql
} from 'drizzle-orm';

import type { Database, DbTransaction } from '../client.js';
import { contacts, invoices } from '../schema/receivables.js';
import {
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages
} from '../schema/reminders.js';
import {
  voiceCallEvents,
  voiceCallInvoices,
  voiceCallRequests,
  type VoiceCallSource
} from '../schema/voice.js';

type VoiceCallRequestRow = typeof voiceCallRequests.$inferSelect;
type VoiceCallInvoiceRow = typeof voiceCallInvoices.$inferSelect;
type VoiceCallEventRow = typeof voiceCallEvents.$inferSelect;
type VoiceExecutor = Database | DbTransaction;

export interface VoiceCallAggregate extends VoiceCallRequestRow {
  invoices: VoiceCallInvoiceRow[];
  events: VoiceCallEventRow[];
}

export type VoiceCallExecutionAggregate = VoiceCallAggregate;

export interface CreateVoiceCallInvoiceSnapshotInput {
  invoiceId: string;
  xeroInvoiceId: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  dueDate: string;
  syncVersion: number;
  snapshotAt: Date;
}

export interface CreateVoiceCallDraftInput {
  organisationId: string;
  contactId: string;
  actorUserId: string;
  purpose?: 'CUSTOMER' | 'TEST';
  accountName: string;
  destinationNumber: string;
  outboundNumber: string;
  combinedAmount: string;
  currency: string;
  voipcloudUserNumber: string;
  ttsVoiceId: string;
  gatewayFlowVersion: number;
  agentId: string;
  agentVersion: number;
  voiceId: string;
  voiceSettingsUpdatedAt: Date;
  transferTargetLabel: string;
  idempotencyKey: string;
  invoices: readonly CreateVoiceCallInvoiceSnapshotInput[];
  now: Date;
}

export type VoiceCallSourceInput =
  | { source: 'MANUAL' }
  | {
      source: Exclude<VoiceCallSource, 'MANUAL'>;
      sequenceId: string;
      sequenceVersionId: string;
      stageKey: string;
      scheduledAt: Date;
      localOccurrenceDate: string;
    };

export interface CreateVoiceCallPreparedInput
  extends Omit<CreateVoiceCallDraftInput, 'actorUserId'> {
  actorUserId: string | null;
  initialState: 'DRAFT' | 'APPROVED';
  source: VoiceCallSourceInput;
  callFlowVersion: number | null;
  callFlowHash: string | null;
  approvedFactsHash: string | null;
}

export interface ApproveVoiceCallInput {
  organisationId: string;
  voiceCallId: string;
  actorUserId: string;
  idempotencyKey: string;
  callFlowVersion: number;
  callFlowHash: string;
  approvedFactsHash: string;
  now: Date;
}

export interface ClaimVoiceCallInput {
  organisationId: string;
  voiceCallId: string;
  now: Date;
}

export interface QueueApprovedScheduledVoiceCallInput {
  organisationId: string;
  voiceCallId: string;
  now: Date;
}

export type VoiceCallClaimResult =
  | { kind: 'claimed'; voiceCallId: string }
  | {
      kind: 'existing';
      voiceCallId: string;
      state: VoiceCallOperationalState;
    }
  | {
      kind: 'blocked';
      reason: 'ORGANISATION_CALL_IN_FLIGHT' | 'UNKNOWN_OUTCOME';
    };

export interface ProviderAcceptedInput {
  organisationId: string;
  voiceCallId: string;
  providerCallId: string;
  now: Date;
}

export interface AppendVoiceCallEventInput {
  organisationId: string;
  voiceCallId: string;
  providerEventKey: string;
  eventType: string;
  safeState?: VoiceCallOperationalState;
  safeOutcome?: VoiceCallOutcome;
  safeMetadata?: Record<string, unknown>;
  occurredAt: Date;
  receivedAt?: Date;
}

export interface RecentVoiceAttemptsInput {
  organisationId: string;
  contactId: string;
  from: Date;
  before: Date;
}

export interface VoiceAttempt {
  voiceCallId: string;
  providerAcceptedAt: Date;
  state: VoiceCallOperationalState;
  outcome: VoiceCallOutcome | null;
}

const loadAggregate = async (
  executor: VoiceExecutor,
  organisationId: string,
  voiceCallId: string
): Promise<VoiceCallAggregate | null> => {
  const [request] = await executor
    .select()
    .from(voiceCallRequests)
    .where(
      and(
        eq(voiceCallRequests.organisationId, organisationId),
        eq(voiceCallRequests.id, voiceCallId)
      )
    )
    .limit(1);
  if (request === undefined) return null;

  const invoiceRows = await executor
    .select()
    .from(voiceCallInvoices)
    .where(
      and(
        eq(voiceCallInvoices.organisationId, organisationId),
        eq(voiceCallInvoices.voiceCallId, voiceCallId)
      )
    )
    .orderBy(
      asc(voiceCallInvoices.dueDate),
      asc(voiceCallInvoices.invoiceNumber)
    );
  const eventRows = await executor
    .select()
    .from(voiceCallEvents)
    .where(
      and(
        eq(voiceCallEvents.organisationId, organisationId),
        eq(voiceCallEvents.voiceCallId, voiceCallId)
      )
    )
    .orderBy(
      asc(voiceCallEvents.occurredAt),
      asc(voiceCallEvents.receivedAt)
    );

  return {
    ...request,
    invoices: invoiceRows,
    events: eventRows
  };
};

const assertDraftSources = async (
  transaction: DbTransaction,
  input: Pick<
    CreateVoiceCallDraftInput,
    'organisationId' | 'contactId' | 'accountName' | 'invoices'
  >
): Promise<void> => {
  const [contact] = await transaction
    .select({ id: contacts.id, name: contacts.name })
    .from(contacts)
    .where(
      and(
        eq(contacts.organisationId, input.organisationId),
        eq(contacts.id, input.contactId)
      )
    )
    .limit(1);
  if (
    contact === undefined ||
    contact.name !== input.accountName ||
    input.invoices.length === 0
  ) {
    throw new Error('VOICE_CALL_SOURCE_MISMATCH');
  }

  const requestedIds = [...new Set(input.invoices.map((item) => item.invoiceId))];
  if (requestedIds.length !== input.invoices.length) {
    throw new Error('VOICE_CALL_SOURCE_MISMATCH');
  }
  const sourceRows = await transaction
    .select({
      id: invoices.id,
      xeroInvoiceId: invoices.xeroInvoiceId,
      invoiceNumber: invoices.invoiceNumber,
      amountDue: invoices.amountDue,
      currency: invoices.currency,
      dueDate: invoices.dueDate,
      syncVersion: invoices.syncVersion
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organisationId, input.organisationId),
        eq(invoices.contactId, input.contactId),
        inArray(invoices.id, requestedIds)
      )
    );
  const sourceById = new Map(sourceRows.map((invoice) => [invoice.id, invoice]));

  const canonicalDecimal = (value: string): string | null => {
    const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
    if (match === null) return null;

    const integer = (match[2] ?? '').replace(/^0+(?=\d)/, '') || '0';
    const fraction = (match[3] ?? '').replace(/0+$/, '');
    const isZero = integer === '0' && fraction === '';
    const sign = match[1] === '-' && !isZero ? '-' : '';
    return `${sign}${integer}${fraction === '' ? '' : `.${fraction}`}`;
  };

  const decimalValuesEqual = (left: string, right: string): boolean => {
    const canonicalLeft = canonicalDecimal(left);
    const canonicalRight = canonicalDecimal(right);
    return canonicalLeft !== null && canonicalLeft === canonicalRight;
  };

  for (const snapshot of input.invoices) {
    const source = sourceById.get(snapshot.invoiceId);
    if (
      source === undefined ||
      source.xeroInvoiceId !== snapshot.xeroInvoiceId ||
      source.invoiceNumber !== snapshot.invoiceNumber ||
      !decimalValuesEqual(source.amountDue, snapshot.amountDue) ||
      source.currency !== snapshot.currency ||
      source.dueDate !== snapshot.dueDate ||
      source.syncVersion !== snapshot.syncVersion
    ) {
      throw new Error('VOICE_CALL_SOURCE_MISMATCH');
    }
  }
};

const assertPreparedSource = async (
  transaction: DbTransaction,
  input: CreateVoiceCallPreparedInput
): Promise<void> => {
  if (input.source.source === 'MANUAL') return;

  const [source] = await transaction
    .select({ id: sequenceStages.id })
    .from(reminderSequences)
    .innerJoin(
      reminderSequenceVersions,
      and(
        eq(reminderSequenceVersions.id, input.source.sequenceVersionId),
        eq(reminderSequenceVersions.organisationId, input.organisationId),
        eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
        eq(reminderSequenceVersions.status, 'ACTIVE')
      )
    )
    .innerJoin(
      sequenceStages,
      and(
        eq(sequenceStages.organisationId, input.organisationId),
        eq(sequenceStages.sequenceVersionId, reminderSequenceVersions.id),
        eq(sequenceStages.stageKey, input.source.stageKey),
        eq(sequenceStages.channel, 'VOICE'),
        eq(sequenceStages.enabled, true)
      )
    )
    .where(
      and(
        eq(reminderSequences.id, input.source.sequenceId),
        eq(reminderSequences.organisationId, input.organisationId),
        eq(reminderSequences.kind, 'VOICE'),
        eq(reminderSequences.enabled, true),
        eq(
          reminderSequences.mode,
          input.source.source === 'SEQUENCE_AUTOMATIC'
            ? 'AUTOMATIC'
            : 'REVIEW'
        )
      )
    )
    .limit(1);
  if (source === undefined) throw new Error('VOICE_CALL_SOURCE_MISMATCH');
};

export class PostgresVoiceCallRepository {
  constructor(private readonly database: Database) {}

  async createDraft(
    input: CreateVoiceCallDraftInput
  ): Promise<VoiceCallAggregate> {
    return this.createPrepared({
      ...input,
      initialState: 'DRAFT',
      source: { source: 'MANUAL' },
      callFlowVersion: null,
      callFlowHash: null,
      approvedFactsHash: null
    });
  }

  async createPrepared(
    input: CreateVoiceCallPreparedInput
  ): Promise<VoiceCallAggregate> {
    if (
      input.initialState === 'APPROVED' &&
      (input.callFlowVersion === null ||
        input.callFlowHash === null ||
        input.approvedFactsHash === null)
    ) {
      throw new Error('VOICE_CALL_APPROVED_FACTS_REQUIRED');
    }
    return this.database.transaction(async (transaction) => {
      await assertDraftSources(transaction, input);
      await assertPreparedSource(transaction, input);
      const [created] = await transaction
        .insert(voiceCallRequests)
        .values({
          organisationId: input.organisationId,
          contactId: input.contactId,
          actorUserId: input.actorUserId,
          provider: 'VOIPCLOUD',
          purpose: input.purpose ?? 'CUSTOMER',
          source: input.source.source,
          sequenceId:
            input.source.source === 'MANUAL'
              ? null
              : input.source.sequenceId,
          sequenceVersionId:
            input.source.source === 'MANUAL'
              ? null
              : input.source.sequenceVersionId,
          stageKey:
            input.source.source === 'MANUAL' ? null : input.source.stageKey,
          scheduledAt:
            input.source.source === 'MANUAL'
              ? null
              : input.source.scheduledAt,
          localOccurrenceDate:
            input.source.source === 'MANUAL'
              ? null
              : input.source.localOccurrenceDate,
          accountName: input.accountName,
          destinationNumber: input.destinationNumber,
          outboundNumber: input.outboundNumber,
          combinedAmount: input.combinedAmount,
          currency: input.currency,
          voipcloudUserNumber: input.voipcloudUserNumber,
          ttsVoiceId: input.ttsVoiceId,
          gatewayFlowVersion: input.gatewayFlowVersion,
          agentId: input.agentId,
          agentVersion: input.agentVersion,
          voiceId: input.voiceId,
          voiceSettingsUpdatedAt: input.voiceSettingsUpdatedAt,
          transferTargetLabel: input.transferTargetLabel,
          idempotencyKey: input.idempotencyKey,
          state: 'DRAFT',
          callFlowVersion: null,
          callFlowHash: null,
          approvedFactsHash: null,
          approvedAt: null,
          createdAt: input.now,
          updatedAt: input.now
        })
        .onConflictDoNothing({
          target: [
            voiceCallRequests.organisationId,
            voiceCallRequests.idempotencyKey
          ]
        })
        .returning({ id: voiceCallRequests.id });
      if (created === undefined) {
        const [existing] = await transaction
          .select({
            id: voiceCallRequests.id,
            contactId: voiceCallRequests.contactId,
            source: voiceCallRequests.source,
            sequenceId: voiceCallRequests.sequenceId,
            sequenceVersionId: voiceCallRequests.sequenceVersionId,
            stageKey: voiceCallRequests.stageKey,
            scheduledAt: voiceCallRequests.scheduledAt,
            localOccurrenceDate: voiceCallRequests.localOccurrenceDate
          })
          .from(voiceCallRequests)
          .where(
            and(
              eq(voiceCallRequests.organisationId, input.organisationId),
              eq(voiceCallRequests.idempotencyKey, input.idempotencyKey)
            )
          )
          .limit(1);
        const sourceMatches =
          existing !== undefined &&
          existing.contactId === input.contactId &&
          existing.source === input.source.source &&
          (input.source.source === 'MANUAL' ||
            (existing.sequenceId === input.source.sequenceId &&
              existing.sequenceVersionId === input.source.sequenceVersionId &&
              existing.stageKey === input.source.stageKey &&
              existing.scheduledAt?.getTime() ===
                input.source.scheduledAt.getTime() &&
              existing.localOccurrenceDate === input.source.localOccurrenceDate));
        if (!sourceMatches || existing === undefined) {
          throw new Error('VOICE_CALL_SOURCE_MISMATCH');
        }
        const aggregate = await loadAggregate(
          transaction,
          input.organisationId,
          existing.id
        );
        if (aggregate === null) throw new Error('VOICE_CALL_NOT_CREATED');
        return aggregate;
      }

      await transaction.insert(voiceCallInvoices).values(
        input.invoices.map((invoice) => ({
          voiceCallId: created.id,
          organisationId: input.organisationId,
          ...invoice
        }))
      );
      if (input.initialState === 'APPROVED') {
        await transaction
          .update(voiceCallRequests)
          .set({
            state: 'APPROVED',
            callFlowVersion: input.callFlowVersion,
            callFlowHash: input.callFlowHash,
            approvedFactsHash: input.approvedFactsHash,
            approvedAt: input.now,
            updatedAt: input.now
          })
          .where(eq(voiceCallRequests.id, created.id));
      }
      const aggregate = await loadAggregate(
        transaction,
        input.organisationId,
        created.id
      );
      if (aggregate === null) throw new Error('VOICE_CALL_NOT_CREATED');
      return aggregate;
    });
  }

  async approveAndQueue(
    input: ApproveVoiceCallInput
  ): Promise<{ voiceCallId: string; created: boolean }> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({
          id: voiceCallRequests.id,
          state: voiceCallRequests.state,
          idempotencyKey: voiceCallRequests.idempotencyKey,
          callFlowVersion: voiceCallRequests.callFlowVersion,
          callFlowHash: voiceCallRequests.callFlowHash,
          approvedFactsHash: voiceCallRequests.approvedFactsHash,
          approvedAt: voiceCallRequests.approvedAt
        })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, input.voiceCallId)
          )
        )
        .for('update')
        .limit(1);
      if (current === undefined) throw new Error('VOICE_CALL_NOT_FOUND');
      if (current.idempotencyKey !== input.idempotencyKey) {
        throw new Error('VOICE_CALL_APPROVAL_MISMATCH');
      }
      if (current.state !== 'DRAFT') {
        if (
          current.approvedAt !== null &&
          current.callFlowVersion === input.callFlowVersion &&
          current.callFlowHash === input.callFlowHash &&
          current.approvedFactsHash === input.approvedFactsHash
        ) {
          return { voiceCallId: current.id, created: false };
        }
        throw new Error('VOICE_CALL_APPROVAL_MISMATCH');
      }

      await transaction
        .update(voiceCallRequests)
        .set({
          actorUserId: input.actorUserId,
          callFlowVersion: input.callFlowVersion,
          callFlowHash: input.callFlowHash,
          approvedFactsHash: input.approvedFactsHash,
          state: 'QUEUED',
          approvedAt: input.now,
          queuedAt: input.now,
          updatedAt: input.now
        })
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, input.voiceCallId),
            eq(voiceCallRequests.state, 'DRAFT')
          )
        );
      return { voiceCallId: current.id, created: true };
    });
  }

  loadForExecution(
    organisationId: string,
    voiceCallId: string
  ): Promise<VoiceCallExecutionAggregate | null> {
    return loadAggregate(this.database, organisationId, voiceCallId);
  }

  async queueApprovedScheduledCall(
    input: QueueApprovedScheduledVoiceCallInput,
    transaction?: DbTransaction
  ): Promise<{ voiceCallId: string; queued: boolean }> {
    const executor = transaction ?? this.database;
    const [queued] = await executor
      .update(voiceCallRequests)
      .set({
        state: 'QUEUED',
        queuedAt: input.now,
        updatedAt: input.now
      })
      .where(
        and(
          eq(voiceCallRequests.organisationId, input.organisationId),
          eq(voiceCallRequests.id, input.voiceCallId),
          eq(voiceCallRequests.state, 'APPROVED'),
          ne(voiceCallRequests.source, 'MANUAL'),
          lte(voiceCallRequests.scheduledAt, input.now)
        )
      )
      .returning({ id: voiceCallRequests.id });
    return { voiceCallId: input.voiceCallId, queued: queued !== undefined };
  }

  async claimForSubmission(
    input: ClaimVoiceCallInput
  ): Promise<VoiceCallClaimResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.organisationId}, 0))`
      );
      const [current] = await transaction
        .select({
          id: voiceCallRequests.id,
          contactId: voiceCallRequests.contactId,
          state: voiceCallRequests.state
        })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, input.voiceCallId)
          )
        )
        .for('update')
        .limit(1);
      if (current === undefined) throw new Error('VOICE_CALL_NOT_FOUND');
      if (current.state !== 'QUEUED') {
        return {
          kind: 'existing',
          voiceCallId: current.id,
          state: current.state
        };
      }

      const [unknown] = await transaction
        .select({ id: voiceCallRequests.id })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.state, 'UNKNOWN'),
            ne(voiceCallRequests.id, current.id)
          )
        )
        .limit(1);
      if (unknown !== undefined) {
        return { kind: 'blocked', reason: 'UNKNOWN_OUTCOME' };
      }

      const [inFlight] = await transaction
        .select({ id: voiceCallRequests.id })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            inArray(voiceCallRequests.state, [
              'SUBMITTING',
              'ACCEPTED',
              'IN_PROGRESS'
            ]),
            ne(voiceCallRequests.id, current.id)
          )
        )
        .limit(1);
      if (inFlight !== undefined) {
        return {
          kind: 'blocked',
          reason: 'ORGANISATION_CALL_IN_FLIGHT'
        };
      }

      await transaction
        .update(voiceCallRequests)
        .set({ state: 'SUBMITTING', updatedAt: input.now })
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, current.id),
            eq(voiceCallRequests.state, 'QUEUED')
          )
        );
      return { kind: 'claimed', voiceCallId: current.id };
    });
  }

  async recordProviderAccepted(
    input: ProviderAcceptedInput
  ): Promise<void> {
    const updated = await this.database
      .update(voiceCallRequests)
      .set({
        state: 'ACCEPTED',
        providerCallId: input.providerCallId,
        providerAcceptedAt: input.now,
        updatedAt: input.now
      })
      .where(
        and(
          eq(voiceCallRequests.organisationId, input.organisationId),
          eq(voiceCallRequests.id, input.voiceCallId),
          eq(voiceCallRequests.state, 'SUBMITTING')
        )
      )
      .returning({ id: voiceCallRequests.id });
    if (updated.length !== 1) throw new Error('VOICE_CALL_NOT_SUBMITTING');
  }

  async appendEvent(
    input: AppendVoiceCallEventInput
  ): Promise<{ created: boolean }> {
    return this.database.transaction(async (transaction) => {
      const [ownedCall] = await transaction
        .select({ id: voiceCallRequests.id })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, input.organisationId),
            eq(voiceCallRequests.id, input.voiceCallId)
          )
        )
        .limit(1);
      if (ownedCall === undefined) throw new Error('VOICE_CALL_NOT_FOUND');

      const inserted = await transaction
        .insert(voiceCallEvents)
        .values({
          organisationId: input.organisationId,
          voiceCallId: input.voiceCallId,
          provider: 'VOIPCLOUD',
          providerEventKey: input.providerEventKey,
          eventType: input.eventType,
          safeState: input.safeState,
          safeOutcome: input.safeOutcome,
          safeMetadata: input.safeMetadata,
          occurredAt: input.occurredAt,
          receivedAt: input.receivedAt
        })
        .onConflictDoNothing({
          target: [
            voiceCallEvents.organisationId,
            voiceCallEvents.provider,
            voiceCallEvents.providerEventKey
          ]
        })
        .returning({ id: voiceCallEvents.id });
      return { created: inserted.length === 1 };
    });
  }

  async recentProviderAcceptedAttempts(
    input: RecentVoiceAttemptsInput
  ): Promise<ReadonlyArray<VoiceAttempt>> {
    const rows = await this.database
      .select({
        voiceCallId: voiceCallRequests.id,
        providerAcceptedAt: voiceCallRequests.providerAcceptedAt,
        state: voiceCallRequests.state,
        outcome: voiceCallRequests.outcome
      })
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, input.organisationId),
          eq(voiceCallRequests.contactId, input.contactId),
          eq(voiceCallRequests.purpose, 'CUSTOMER'),
          isNotNull(voiceCallRequests.providerAcceptedAt),
          gte(voiceCallRequests.providerAcceptedAt, input.from),
          lt(voiceCallRequests.providerAcceptedAt, input.before)
        )
      )
      .orderBy(asc(voiceCallRequests.providerAcceptedAt));

    return rows.map((row) => ({
      ...row,
      providerAcceptedAt: row.providerAcceptedAt as Date
    }));
  }

  async findByProviderCallId(
    organisationId: string,
    providerCallId: string,
    provider: 'RETELL' | 'VOIPCLOUD' = 'VOIPCLOUD'
  ): Promise<VoiceCallAggregate | null> {
    const [request] = await this.database
      .select({ id: voiceCallRequests.id })
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, organisationId),
          eq(voiceCallRequests.provider, provider),
          eq(voiceCallRequests.providerCallId, providerCallId)
        )
      )
      .limit(1);
    if (request === undefined) return null;
    return loadAggregate(this.database, organisationId, request.id);
  }
}
