import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  decideSmsAllowance,
  summariseSmsUsage,
  type SmsAllowanceBlocker
} from '@bc5000/domain';

import type { Database, DbTransaction } from '../connection.js';
import {
  auditEvents,
  organisationOnboarding,
  organisations,
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  subscriptions,
  type OutboundSource
} from '../schema/index.js';

type Executor = Database | DbTransaction;

export interface SmsUsageView {
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  includedParts: number;
  warningPercent: number;
  committedParts: number;
  reservedParts: number;
  overageParts: number;
  overageEnabled: boolean;
  overageCapCents: number | null;
}

export type SmsUsageReservation =
  | { kind: 'bypassed'; sourceNumber: null }
  | { kind: 'blocked'; reason: SmsAllowanceBlocker | 'REPLY_NUMBER_NOT_READY' }
  | {
      kind: 'reserved';
      sourceNumber: string;
      warningThresholdReached: boolean;
      alreadyReserved: boolean;
    };

const reservationKey = (outboundMessageId: string): string =>
  `${outboundMessageId}:reserve`;
const commitKey = (outboundMessageId: string): string =>
  `${outboundMessageId}:commit`;
const releaseKey = (outboundMessageId: string): string =>
  `${outboundMessageId}:release`;

export class PostgresSmsCommerceRepository {
  constructor(private readonly database: Database) {}

  async reserveUsage(
    input: {
      organisationId: string;
      outboundMessageId: string;
      source: OutboundSource;
      partCount: number;
      now: Date;
    },
    executor?: Executor
  ): Promise<SmsUsageReservation> {
    if (executor === undefined) {
      return this.database.transaction((transaction) =>
        this.reserveUsage(input, transaction)
      );
    }
    if (!Number.isInteger(input.partCount) || input.partCount < 1) {
      throw new Error('SMS_PART_COUNT_INVALID');
    }
    const [organisation] = await executor
      .select({ edition: organisations.edition })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .limit(1);
    if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
    if (organisation.edition === 'INTERNAL_LEGACY') {
      return { kind: 'bypassed', sourceNumber: null };
    }

    const [subscription] = await executor
      .select({
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd
      })
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, input.organisationId))
      .for('update')
      .limit(1);
    if (
      subscription?.currentPeriodStart === null ||
      subscription?.currentPeriodStart === undefined ||
      subscription.currentPeriodEnd === null
    ) {
      throw new Error('SMS_BILLING_PERIOD_MISSING');
    }

    const [number] = await executor
      .select({ e164Number: smsNumberPool.e164Number })
      .from(smsNumberPool)
      .where(
        and(
          eq(smsNumberPool.organisationId, input.organisationId),
          eq(smsNumberPool.status, 'READY')
        )
      )
      .limit(1);
    if (number === undefined) {
      return { kind: 'blocked', reason: 'REPLY_NUMBER_NOT_READY' };
    }

    await executor
      .insert(smsAllowanceSettings)
      .values({ organisationId: input.organisationId })
      .onConflictDoNothing({ target: smsAllowanceSettings.organisationId });
    const [settings] = await executor
      .select()
      .from(smsAllowanceSettings)
      .where(eq(smsAllowanceSettings.organisationId, input.organisationId))
      .for('update')
      .limit(1);
    if (settings === undefined) throw new Error('SMS_ALLOWANCE_SETTINGS_MISSING');

    const [existing] = await executor
      .select({ id: smsUsageLedger.id })
      .from(smsUsageLedger)
      .where(
        and(
          eq(smsUsageLedger.organisationId, input.organisationId),
          eq(smsUsageLedger.idempotencyKey, reservationKey(input.outboundMessageId))
        )
      )
      .limit(1);
    if (existing !== undefined) {
      return {
        kind: 'reserved',
        sourceNumber: number.e164Number,
        warningThresholdReached: false,
        alreadyReserved: true
      };
    }

    const entries = await executor
      .select({
        entryType: smsUsageLedger.entryType,
        partDelta: smsUsageLedger.partDelta
      })
      .from(smsUsageLedger)
      .where(
        and(
          eq(smsUsageLedger.organisationId, input.organisationId),
          eq(
            smsUsageLedger.billingPeriodStart,
            subscription.currentPeriodStart
          ),
          eq(smsUsageLedger.billingPeriodEnd, subscription.currentPeriodEnd)
        )
      );
    const usage = summariseSmsUsage(entries);
    const decision = decideSmsAllowance({
      ...usage,
      requestedParts: input.partCount,
      includedParts: settings.includedParts,
      warningPercent: settings.warningPercent,
      overageEnabled: settings.overageEnabled,
      overageCapCents: settings.overageCapCents,
      overageCentsPerPart: settings.overageCentsPerPart
    });
    if (decision.kind === 'blocked') return decision;

    await executor.insert(smsUsageLedger).values({
      organisationId: input.organisationId,
      billingPeriodStart: subscription.currentPeriodStart,
      billingPeriodEnd: subscription.currentPeriodEnd,
      outboundMessageId: input.outboundMessageId,
      source: input.source,
      entryType: 'RESERVE',
      partDelta: input.partCount,
      idempotencyKey: reservationKey(input.outboundMessageId),
      occurredAt: input.now
    });
    return {
      kind: 'reserved',
      sourceNumber: number.e164Number,
      warningThresholdReached: decision.warningThresholdReached,
      alreadyReserved: false
    };
  }

  async commitUsage(
    organisationId: string,
    outboundMessageId: string,
    now: Date,
    executor?: Executor
  ): Promise<void> {
    if (executor === undefined) {
      await this.database.transaction((transaction) =>
        this.finaliseReservation(
          organisationId,
          outboundMessageId,
          'COMMIT',
          now,
          transaction
        )
      );
      return;
    }
    await this.finaliseReservation(
      organisationId,
      outboundMessageId,
      'COMMIT',
      now,
      executor
    );
  }

  async releaseUsage(
    organisationId: string,
    outboundMessageId: string,
    now: Date,
    executor?: Executor
  ): Promise<void> {
    if (executor === undefined) {
      await this.database.transaction((transaction) =>
        this.finaliseReservation(
          organisationId,
          outboundMessageId,
          'RELEASE',
          now,
          transaction
        )
      );
      return;
    }
    await this.finaliseReservation(
      organisationId,
      outboundMessageId,
      'RELEASE',
      now,
      executor
    );
  }

  private async finaliseReservation(
    organisationId: string,
    outboundMessageId: string,
    entryType: 'COMMIT' | 'RELEASE',
    now: Date,
    executor: Executor
  ): Promise<void> {
    const [reservation] = await executor
      .select()
      .from(smsUsageLedger)
      .where(
        and(
          eq(smsUsageLedger.organisationId, organisationId),
          eq(smsUsageLedger.idempotencyKey, reservationKey(outboundMessageId))
        )
      )
      .limit(1);
    if (reservation === undefined) return;
    const terminalEntries = await executor
      .select({ entryType: smsUsageLedger.entryType })
      .from(smsUsageLedger)
      .where(
        and(
          eq(smsUsageLedger.organisationId, organisationId),
          inArray(smsUsageLedger.idempotencyKey, [
            commitKey(outboundMessageId),
            releaseKey(outboundMessageId)
          ])
        )
      );
    if (terminalEntries.some((entry) => entry.entryType === entryType)) return;
    if (terminalEntries.length > 0) {
      throw new Error('SMS_USAGE_RESERVATION_ALREADY_FINALISED');
    }
    await executor
      .insert(smsUsageLedger)
      .values({
        organisationId,
        billingPeriodStart: reservation.billingPeriodStart,
        billingPeriodEnd: reservation.billingPeriodEnd,
        outboundMessageId,
        source: reservation.source,
        entryType,
        partDelta:
          entryType === 'COMMIT'
            ? reservation.partDelta
            : -reservation.partDelta,
        idempotencyKey:
          entryType === 'COMMIT'
            ? commitKey(outboundMessageId)
            : releaseKey(outboundMessageId),
        occurredAt: now
      })
      .onConflictDoNothing({
        target: [
          smsUsageLedger.organisationId,
          smsUsageLedger.idempotencyKey
        ]
      });
  }

  async loadUsage(
    organisationId: string,
    executor: Executor = this.database
  ): Promise<SmsUsageView | null> {
    const [subscription] = await executor
      .select({
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd
      })
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, organisationId))
      .limit(1);
    if (
      subscription?.currentPeriodStart === null ||
      subscription?.currentPeriodStart === undefined ||
      subscription.currentPeriodEnd === null
    ) {
      return null;
    }
    const [settings] = await executor
      .select()
      .from(smsAllowanceSettings)
      .where(eq(smsAllowanceSettings.organisationId, organisationId))
      .limit(1);
    const effective = settings ?? {
      includedParts: 2_000,
      warningPercent: 80,
      overageEnabled: false,
      overageCapCents: null
    };
    const entries = await executor
      .select({
        entryType: smsUsageLedger.entryType,
        partDelta: smsUsageLedger.partDelta
      })
      .from(smsUsageLedger)
      .where(
        and(
          eq(smsUsageLedger.organisationId, organisationId),
          eq(
            smsUsageLedger.billingPeriodStart,
            subscription.currentPeriodStart
          ),
          eq(smsUsageLedger.billingPeriodEnd, subscription.currentPeriodEnd)
        )
      );
    const usage = summariseSmsUsage(entries);
    return {
      billingPeriodStart: subscription.currentPeriodStart,
      billingPeriodEnd: subscription.currentPeriodEnd,
      includedParts: effective.includedParts,
      warningPercent: effective.warningPercent,
      committedParts: usage.committedParts,
      reservedParts: usage.reservedParts,
      overageParts: Math.max(
        0,
        usage.committedParts + usage.reservedParts - effective.includedParts
      ),
      overageEnabled: effective.overageEnabled,
      overageCapCents: effective.overageCapCents
    };
  }

  async reserveAvailableNumber(
    organisationId: string,
    now: Date
  ): Promise<{ id: string; e164Number: string; status: 'RESERVED' | 'READY' }> {
    return this.database.transaction(async (transaction) => {
      const [subscription] = await transaction
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.organisationId, organisationId))
        .for('update')
        .limit(1);
      if (
        subscription === undefined ||
        !['ACTIVE', 'CANCEL_AT_PERIOD_END'].includes(subscription.status)
      ) {
        throw new Error('PAID_SUBSCRIPTION_REQUIRED');
      }
      const [existing] = await transaction
        .select({
          id: smsNumberPool.id,
          e164Number: smsNumberPool.e164Number,
          status: smsNumberPool.status
        })
        .from(smsNumberPool)
        .where(
          and(
            eq(smsNumberPool.organisationId, organisationId),
            inArray(smsNumberPool.status, [
              'RESERVED',
              'READY',
              'QUARANTINED'
            ])
          )
        )
        .limit(1);
      if (existing !== undefined) {
        if (existing.status === 'QUARANTINED') {
          await transaction
            .update(smsNumberPool)
            .set({
              status: 'RESERVED',
              reservedAt: now,
              readyAt: null,
              quarantineUntil: null,
              updatedAt: now
            })
            .where(eq(smsNumberPool.id, existing.id));
          await transaction.insert(auditEvents).values({
            organisationId,
            eventType: 'SMS_REPLY_NUMBER_RESTORED',
            entityType: 'SMS_NUMBER',
            entityId: existing.id,
            afterValue: { status: 'RESERVED' },
            occurredAt: now
          });
          return {
            id: existing.id,
            e164Number: existing.e164Number,
            status: 'RESERVED'
          };
        }
        return {
          id: existing.id,
          e164Number: existing.e164Number,
          status: existing.status as 'RESERVED' | 'READY'
        };
      }
      const [available] = await transaction
        .select({ id: smsNumberPool.id, e164Number: smsNumberPool.e164Number })
        .from(smsNumberPool)
        .where(eq(smsNumberPool.status, 'AVAILABLE'))
        .orderBy(asc(smsNumberPool.createdAt))
        .for('update')
        .limit(1);
      if (available === undefined) throw new Error('SMS_NUMBER_POOL_EXHAUSTED');
      await transaction
        .update(smsNumberPool)
        .set({
          status: 'RESERVED',
          organisationId,
          reservedAt: now,
          readyAt: null,
          releasedAt: null,
          quarantineUntil: null,
          updatedAt: now
        })
        .where(eq(smsNumberPool.id, available.id));
      await transaction.insert(auditEvents).values({
        organisationId,
        eventType: 'SMS_REPLY_NUMBER_RESERVED',
        entityType: 'SMS_NUMBER',
        entityId: available.id,
        afterValue: { providerOwned: true, status: 'RESERVED' },
        occurredAt: now
      });
      return { ...available, status: 'RESERVED' as const };
    });
  }

  async markNumberReady(
    organisationId: string,
    numberId: string,
    now: Date
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(smsNumberPool)
        .set({ status: 'READY', readyAt: now, updatedAt: now })
        .where(
          and(
            eq(smsNumberPool.id, numberId),
            eq(smsNumberPool.organisationId, organisationId),
            eq(smsNumberPool.status, 'RESERVED')
          )
        )
        .returning({ id: smsNumberPool.id });
      if (updated.length !== 1) throw new Error('SMS_NUMBER_RESERVATION_NOT_FOUND');
      await transaction
        .insert(organisationOnboarding)
        .values({ organisationId, replyNumberReadyAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: organisationOnboarding.organisationId,
          set: { replyNumberReadyAt: now, updatedAt: now }
        });
      await transaction.insert(auditEvents).values({
        organisationId,
        eventType: 'SMS_REPLY_NUMBER_READY',
        entityType: 'SMS_NUMBER',
        entityId: numberId,
        afterValue: { status: 'READY' },
        occurredAt: now
      });
    });
  }

  async quarantineNumber(
    organisationId: string,
    quarantineUntil: Date,
    now: Date
  ): Promise<void> {
    if (quarantineUntil.getTime() <= now.getTime()) {
      throw new Error('SMS_NUMBER_QUARANTINE_INVALID');
    }
    await this.database.transaction(async (transaction) => {
      const quarantined = await transaction
        .update(smsNumberPool)
        .set({ status: 'QUARANTINED', quarantineUntil, updatedAt: now })
        .where(
          and(
            eq(smsNumberPool.organisationId, organisationId),
            inArray(smsNumberPool.status, ['RESERVED', 'READY'])
          )
        )
        .returning({ id: smsNumberPool.id });
      await transaction
        .update(organisationOnboarding)
        .set({ replyNumberReadyAt: null, updatedAt: now })
        .where(eq(organisationOnboarding.organisationId, organisationId));
      for (const number of quarantined) {
        await transaction.insert(auditEvents).values({
          organisationId,
          eventType: 'SMS_REPLY_NUMBER_QUARANTINED',
          entityType: 'SMS_NUMBER',
          entityId: number.id,
          afterValue: {
            status: 'QUARANTINED',
            quarantineUntil: quarantineUntil.toISOString()
          },
          occurredAt: now
        });
      }
    });
  }

  async findOrganisationIdByDestinationNumber(
    destinationNumber: string
  ): Promise<string | null> {
    const [number] = await this.database
      .select({ organisationId: smsNumberPool.organisationId })
      .from(smsNumberPool)
      .where(
        and(
          eq(smsNumberPool.e164Number, destinationNumber),
          inArray(smsNumberPool.status, ['READY', 'QUARANTINED'])
        )
      )
      .limit(1);
    return number?.organisationId ?? null;
  }
}
