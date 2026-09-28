import { and, eq } from 'drizzle-orm';

import {
  type Database,
  messageAttempts,
  organisations,
  outboundMessages,
  stageInstances
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

export async function loadProviderSendDecision(
  database: Database,
  input: ProviderSendDecisionInput
): Promise<ProviderSendPolicyDecision> {
  const [organisation] = await database
    .select()
    .from(organisations)
    .where(eq(organisations.id, input.organisationId))
    .for('update')
    .limit(1);
  if (organisation === undefined) {
    return { kind: 'blocked', reason: 'UNSUPPORTED_SENDING_STATE' };
  }

  return evaluateProviderSendPolicy({
    sendMode: organisation.sendMode,
    liveSendAcknowledged: organisation.liveSendAcknowledged,
    rolloutScope: organisation.rolloutScope,
    maintenanceMode: organisation.maintenanceMode,
    source: input.source,
    channel: input.channel,
    destination: input.destination,
    recipientAllowlist: organisation.recipientAllowlist
  });
}

export async function markProviderSendBlocked(
  database: Database,
  input: {
    organisationId: string;
    outboundId: string;
    attemptId: string;
    stageInstanceId: string | null;
    reason: Extract<ProviderSendPolicyDecision, { kind: 'blocked' }>['reason'];
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
