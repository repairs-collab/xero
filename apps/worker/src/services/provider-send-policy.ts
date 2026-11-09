import { and, eq } from 'drizzle-orm';

import {
  type Database,
  type DbTransaction,
  messageAttempts,
  organisations,
  outboundMessages,
  PostgresEntitlementRepository,
  PostgresSmsCommerceRepository,
  stageInstances,
  suppressions
} from '@bc5000/db';
import {
  evaluateProviderSendPolicy,
  type ProviderSendChannel,
  type ProviderSendPolicyDecision,
  type ProviderSendSource
} from '@bc5000/domain';

import {
  decideOutboundEntitlement,
  type EntitlementSendBlocker
} from './outbound-entitlement.js';

export interface ProviderSendDecisionInput {
  organisationId: string;
  source: ProviderSendSource;
  channel: ProviderSendChannel;
  destination: string;
  automatic?: boolean;
  smsPartCount?: number;
  outboundMessageId?: string;
  now: Date;
}

export type { EntitlementSendBlocker } from './outbound-entitlement.js';

export type ProviderDispatchResult<Value> =
  | Exclude<ProviderSendPolicyDecision, { kind: 'provider-call' }>
  | { kind: 'blocked'; reason: EntitlementSendBlocker }
  | { kind: 'suppressed'; source: string }
  | { kind: 'dispatched'; value: Value };

export async function dispatchWithProviderSendLock<Value>(
  database: Database,
  input: ProviderSendDecisionInput,
  dispatch: (
    transaction: DbTransaction,
    context: { smsSourceNumber: string | null }
  ) => Promise<Value>,
  wasDispatched: (value: Value) => boolean = () => true
): Promise<ProviderDispatchResult<Value>> {
  type InternalDispatchResult =
    | ProviderDispatchResult<Value>
    | { kind: 'provider-error'; error: unknown };
  const outcome: InternalDispatchResult = await database.transaction(
    async (transaction): Promise<InternalDispatchResult> => {
    const [organisation] = await transaction
      .select()
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .for('update')
      .limit(1);
    if (organisation === undefined) {
      return { kind: 'blocked', reason: 'UNSUPPORTED_SENDING_STATE' };
    }

    const entitlements = await new PostgresEntitlementRepository(
      database
    ).decide(input.organisationId, input.now, transaction);
    const entitlementDecision = decideOutboundEntitlement(entitlements, {
      source: input.source,
      destination: input.destination,
      automatic: input.automatic ?? false,
      ...(input.smsPartCount === undefined
        ? {}
        : { smsPartCount: input.smsPartCount })
    });
    if (entitlementDecision.kind === 'blocked') return entitlementDecision;
    if (
      entitlementDecision.kind === 'verified-admin-test' ||
      entitlementDecision.kind === 'platform-verification'
    ) {
      if (organisation.maintenanceMode) {
        return { kind: 'blocked', reason: 'OPERATIONAL_MAINTENANCE' };
      }
      return {
        kind: 'dispatched',
        value: await dispatch(transaction, { smsSourceNumber: null })
      };
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

    let smsSourceNumber: string | null = null;
    let reserved = false;
    if (input.channel === 'SMS') {
      if (
        input.outboundMessageId === undefined ||
        input.smsPartCount === undefined
      ) {
        return { kind: 'blocked', reason: 'UNSUPPORTED_SENDING_STATE' } as const;
      }
      const reservation = await new PostgresSmsCommerceRepository(
        database
      ).reserveUsage(
        {
          organisationId: input.organisationId,
          outboundMessageId: input.outboundMessageId,
          source: input.source,
          partCount: input.smsPartCount,
          now: input.now
        },
        transaction
      );
      if (reservation.kind === 'blocked') {
        return { kind: 'blocked', reason: reservation.reason } as const;
      }
      smsSourceNumber = reservation.sourceNumber;
      reserved = reservation.kind === 'reserved';
    }

    try {
      const value = await dispatch(transaction, { smsSourceNumber });
      if (reserved && input.outboundMessageId !== undefined) {
        const smsCommerce = new PostgresSmsCommerceRepository(database);
        if (wasDispatched(value)) {
          await smsCommerce.commitUsage(
            input.organisationId,
            input.outboundMessageId,
            input.now,
            transaction
          );
        } else {
          await smsCommerce.releaseUsage(
            input.organisationId,
            input.outboundMessageId,
            input.now,
            transaction
          );
        }
      }
      return { kind: 'dispatched', value } as const;
    } catch (error) {
      return { kind: 'provider-error', error } as const;
    }
    }
  );
  if (outcome.kind === 'provider-error') throw outcome.error;
  return outcome;
}

export async function releaseSmsUsageReservation(
  database: Database,
  input: {
    organisationId: string;
    outboundMessageId: string;
    now: Date;
  }
): Promise<void> {
  await new PostgresSmsCommerceRepository(database).releaseUsage(
    input.organisationId,
    input.outboundMessageId,
    input.now
  );
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
      | EntitlementSendBlocker
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
