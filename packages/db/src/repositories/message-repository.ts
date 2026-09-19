import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  messageAttempts,
  outboundMessages,
  type OutboundStatus
} from '../schema/messaging.js';
import { stageInstances } from '../schema/reminders.js';

export interface StoredOutboundOutcome {
  outboundId: string;
  status: OutboundStatus;
  providerMessageId: string | null;
}

export interface BeginOutboundInput {
  organisationId: string;
  stageInstanceId: string;
  channel: 'SMS' | 'XERO_EMAIL';
  recipientKey: string;
  sourceVersion: number;
  contentHash: string;
  idempotencyKey: string;
  provider: 'SINCH' | 'XERO';
  now: Date;
}

export type BeginOutboundResult =
  | { kind: 'claimed'; outboundId: string; attemptId: string }
  | { kind: 'existing'; outcome: StoredOutboundOutcome };

export class PostgresMessageRepository {
  constructor(private readonly database: Database) {}

  async findOutcome(
    organisationId: string,
    idempotencyKey: string
  ): Promise<StoredOutboundOutcome | null> {
    const [outbound] = await this.database
      .select()
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.organisationId, organisationId),
          eq(outboundMessages.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    if (outbound === undefined) return null;
    const [attempt] = await this.database
      .select({ providerMessageId: messageAttempts.providerMessageId })
      .from(messageAttempts)
      .where(
        and(
          eq(messageAttempts.organisationId, organisationId),
          eq(messageAttempts.outboundMessageId, outbound.id)
        )
      )
      .orderBy(desc(messageAttempts.attemptNumber))
      .limit(1);
    return {
      outboundId: outbound.id,
      status: outbound.status,
      providerMessageId: attempt?.providerMessageId ?? null
    };
  }

  async begin(input: BeginOutboundInput): Promise<BeginOutboundResult> {
    return this.database.transaction(async (transaction) => {
      await transaction
        .select({ id: stageInstances.id })
        .from(stageInstances)
        .where(
          and(
            eq(stageInstances.organisationId, input.organisationId),
            eq(stageInstances.id, input.stageInstanceId)
          )
        )
        .for('update');

      const [created] = await transaction
        .insert(outboundMessages)
        .values({
          organisationId: input.organisationId,
          stageInstanceId: input.stageInstanceId,
          channel: input.channel,
          recipientKey: input.recipientKey,
          sourceVersion: input.sourceVersion,
          contentHash: input.contentHash,
          idempotencyKey: input.idempotencyKey,
          status: 'SENDING',
          queuedAt: input.now,
          updatedAt: input.now
        })
        .onConflictDoNothing({
          target: [
            outboundMessages.organisationId,
            outboundMessages.idempotencyKey
          ]
        })
        .returning({ id: outboundMessages.id });

      if (created === undefined) {
        const outcome = await this.findOutcome(
          input.organisationId,
          input.idempotencyKey
        );
        if (outcome === null) {
          throw new Error('Outbound conflict could not be resolved');
        }
        return { kind: 'existing', outcome };
      }

      const [attempt] = await transaction
        .insert(messageAttempts)
        .values({
          organisationId: input.organisationId,
          outboundMessageId: created.id,
          attemptNumber: 1,
          provider: input.provider,
          status: 'SENDING',
          requestDispatchedAt: input.now
        })
        .returning({ id: messageAttempts.id });
      if (attempt === undefined) throw new Error('Message attempt was not created');

      await transaction
        .update(stageInstances)
        .set({ status: 'SENDING', updatedAt: input.now })
        .where(
          and(
            eq(stageInstances.organisationId, input.organisationId),
            eq(stageInstances.id, input.stageInstanceId)
          )
        );
      return {
        kind: 'claimed',
        outboundId: created.id,
        attemptId: attempt.id
      };
    });
  }

  async markAccepted(input: {
    organisationId: string;
    stageInstanceId: string;
    outboundId: string;
    attemptId: string;
    providerMessageId?: string;
    providerPayload?: Record<string, unknown>;
    now: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(messageAttempts)
        .set({
          status: 'ACCEPTED',
          providerMessageId: input.providerMessageId,
          providerPayload: input.providerPayload,
          responseReceivedAt: input.now
        })
        .where(
          and(
            eq(messageAttempts.organisationId, input.organisationId),
            eq(messageAttempts.id, input.attemptId)
          )
        );
      await transaction
        .update(outboundMessages)
        .set({
          status: 'ACCEPTED',
          completedAt: input.now,
          updatedAt: input.now
        })
        .where(eq(outboundMessages.id, input.outboundId));
      await transaction
        .update(stageInstances)
        .set({ status: 'SENT', completedAt: input.now, updatedAt: input.now })
        .where(eq(stageInstances.id, input.stageInstanceId));
    });
  }

  async markDryRun(input: {
    outboundId: string;
    attemptId: string;
    stageInstanceId: string;
    now: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(messageAttempts)
        .set({ status: 'DRY_RUN', responseReceivedAt: input.now })
        .where(eq(messageAttempts.id, input.attemptId));
      await transaction
        .update(outboundMessages)
        .set({ status: 'DRY_RUN', completedAt: input.now, updatedAt: input.now })
        .where(eq(outboundMessages.id, input.outboundId));
      await transaction
        .update(stageInstances)
        .set({ status: 'SENT', completedAt: input.now, updatedAt: input.now })
        .where(eq(stageInstances.id, input.stageInstanceId));
    });
  }

  async markRejected(input: {
    outboundId: string;
    attemptId: string;
    stageInstanceId: string;
    errorCode: string;
    now: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(messageAttempts)
        .set({
          status: 'REJECTED',
          errorCode: input.errorCode,
          responseReceivedAt: input.now
        })
        .where(eq(messageAttempts.id, input.attemptId));
      await transaction
        .update(outboundMessages)
        .set({ status: 'FAILED', completedAt: input.now, updatedAt: input.now })
        .where(eq(outboundMessages.id, input.outboundId));
      await transaction
        .update(stageInstances)
        .set({ status: 'REJECTED', completedAt: input.now, updatedAt: input.now })
        .where(eq(stageInstances.id, input.stageInstanceId));
    });
  }

  async markUnknown(input: {
    outboundId: string;
    attemptId: string;
    stageInstanceId: string;
    now: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(messageAttempts)
        .set({ status: 'UNKNOWN', errorCode: 'UNKNOWN_OUTCOME' })
        .where(eq(messageAttempts.id, input.attemptId));
      await transaction
        .update(outboundMessages)
        .set({ status: 'UNKNOWN', updatedAt: input.now })
        .where(eq(outboundMessages.id, input.outboundId));
      await transaction
        .update(stageInstances)
        .set({ status: 'UNKNOWN', updatedAt: input.now })
        .where(eq(stageInstances.id, input.stageInstanceId));
    });
  }
}
