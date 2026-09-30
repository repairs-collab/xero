import { and, eq } from 'drizzle-orm';

import {
  type Database,
  type DbTransaction,
  messageAttempts,
  organisations,
  outboundMessages,
  stageInstances,
  suppressions
} from '@bc5000/db';
import {
  evaluateProviderSendPolicy,
  type ProviderSendChannel,
  type ProviderSendPolicyDecision,
  type ProviderSendSource
} from '@bc5000/domain';

export interface ProviderSendDecisionInput {
  organisationId: string;
  source: ProviderSendSource;
  channel: ProviderSendChannel;
  destination: string;
}

export type ProviderDispatchResult<Value> =
  | Exclude<ProviderSendPolicyDecision, { kind: 'provider-call' }>
  | { kind: 'suppressed'; source: string }
  | { kind: 'dispatched'; value: Value };

export async function dispatchWithProviderSendLock<Value>(
  database: Database,
  input: ProviderSendDecisionInput,
  dispatch: (transaction: DbTransaction) => Promise<Value>
): Promise<ProviderDispatchResult<Value>> {
  return database.transaction(async (transaction) => {
    const [organisation] = await transaction
      .select()
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .for('update')
      .limit(1);
    if (organisation === undefined) {
      return { kind: 'blocked', reason: 'UNSUPPORTED_SENDING_STATE' };
    }

    const decision = evaluateProviderSendPolicy({
      sendMode: organisation.sendMode,
      liveSendAcknowledged: organisation.liveSendAcknowledged,
      rolloutScope: organisation.rolloutScope,
      maintenanceMode: organisation.maintenanceMode,
      source: input.source,
      channel: input.channel,
      destination: input.destination,
      recipientAllowlist: organisation.recipientAllowlist
    });
    if (decision.kind !== 'provider-call') return decision;

    const [suppression] = await transaction
      .select({ source: suppressions.source })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.organisationId, input.organisationId),
          eq(suppressions.channel, input.channel),
          eq(suppressions.normalisedDestination, input.destination),
          eq(suppressions.consentState, 'SUPPRESSED')
        )
      )
      .limit(1);
    if (suppression !== undefined) {
      return { kind: 'suppressed', source: suppression.source };
    }

    return { kind: 'dispatched', value: await dispatch(transaction) };
  });
}

export async function markProviderSendBlocked(
  database: Database,
  input: {
    organisationId: string;
    outboundId: string;
    attemptId: string;
    stageInstanceId: string | null;
    reason:
      | Extract<ProviderSendPolicyDecision, { kind: 'blocked' }>['reason']
      | 'CHANNEL_SUPPRESSED'
      | 'OUTSIDE_SCHEDULE_WINDOW'
      | 'SOURCE_CHANGED'
      | `SUPPRESSED:${string}`;
    now: Date;
  }
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .update(messageAttempts)
      .set({
        status: 'CANCELLED',
        errorCode: input.reason,
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
        status: 'CANCELLED',
        failureReason: input.reason,
        completedAt: input.now,
        updatedAt: input.now
      })
      .where(
        and(
          eq(outboundMessages.organisationId, input.organisationId),
          eq(outboundMessages.id, input.outboundId)
        )
      );
    if (input.stageInstanceId !== null) {
      await transaction
        .update(stageInstances)
        .set({ status: 'CANCELLED', completedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(stageInstances.organisationId, input.organisationId),
            eq(stageInstances.id, input.stageInstanceId)
          )
        );
    }
  });
}
