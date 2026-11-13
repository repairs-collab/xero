import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql
} from 'drizzle-orm';

import {
  decideSmsAllowance,
  hasPaidSubscriptionAccess,
  soloIncludedSmsParts,
  soloSmsOverageCentsPerPart,
  summariseSmsUsage,
  type SmsAllowanceBlocker
} from '@bc5000/domain';

import type { Database, DbTransaction } from '../connection.js';
import {
  auditEvents,
  organisationOnboarding,
  organisations,
  replyNumberProvisioningRequests,
  smsAllowanceSettings,
  smsNumberPool,
  smsOverageStatements,
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
  remainingParts: number;
  overageParts: number;
  overageEnabled: boolean;
  overageCentsPerPart: number | null;
  estimatedOverageCents: number;
}

export interface SmsAllowanceView {
  includedParts: number;
  warningPercent: number;
  overageEnabled: boolean;
  overageCapCents: number | null;
  overageCentsPerPart: number | null;
}

export type SmsOverageStatement = typeof smsOverageStatements.$inferSelect;

export type SmsUsageReservation =
  | { kind: 'bypassed'; sourceNumber: null }
  | { kind: 'blocked'; reason: SmsAllowanceBlocker; projectedParts: number }
  | { kind: 'blocked'; reason: 'REPLY_NUMBER_NOT_READY' }
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

const addUtcMonthsClamped = (anchor: Date, months: number): Date => {
  const targetMonth = anchor.getUTCMonth() + months;
  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0)
  ).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds()
    )
  );
};

const monthlyAllowancePeriod = (input: {
  subscriptionPeriodStart: Date;
  subscriptionPeriodEnd: Date;
  at: Date;
}): { start: Date; end: Date } => {
  const { subscriptionPeriodStart, subscriptionPeriodEnd, at } = input;
  if (
    subscriptionPeriodEnd.getTime() <= subscriptionPeriodStart.getTime() ||
    at.getTime() < subscriptionPeriodStart.getTime() ||
    at.getTime() >= subscriptionPeriodEnd.getTime()
  ) {
    throw new Error('SMS_ALLOWANCE_PERIOD_INACTIVE');
  }
  let monthOffset = Math.max(
    0,
    (at.getUTCFullYear() - subscriptionPeriodStart.getUTCFullYear()) * 12 +
      at.getUTCMonth() -
      subscriptionPeriodStart.getUTCMonth()
  );
  let start = addUtcMonthsClamped(subscriptionPeriodStart, monthOffset);
  if (start.getTime() > at.getTime()) {
    monthOffset -= 1;
    start = addUtcMonthsClamped(subscriptionPeriodStart, monthOffset);
  }
  let end = addUtcMonthsClamped(subscriptionPeriodStart, monthOffset + 1);
  while (
    at.getTime() >= end.getTime() &&
    end.getTime() < subscriptionPeriodEnd.getTime()
  ) {
    monthOffset += 1;
    start = end;
    end = addUtcMonthsClamped(subscriptionPeriodStart, monthOffset + 1);
  }
  if (end.getTime() > subscriptionPeriodEnd.getTime()) {
    end = subscriptionPeriodEnd;
  }
  return { start, end };
};

export class PostgresSmsCommerceRepository {
  constructor(
    private readonly database: Database,
    private readonly clock: { now(): Date } = { now: () => new Date() }
  ) {}

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
    const allowancePeriod = monthlyAllowancePeriod({
      subscriptionPeriodStart: subscription.currentPeriodStart,
      subscriptionPeriodEnd: subscription.currentPeriodEnd,
      at: input.now
    });

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
      .select({
        includedParts: smsAllowanceSettings.includedParts,
        warningPercent: smsAllowanceSettings.warningPercent,
        overageEnabled: smsAllowanceSettings.overageEnabled,
        overageCapCents: smsAllowanceSettings.overageCapCents,
        overageCentsPerPart: smsAllowanceSettings.overageCentsPerPart
      })
      .from(smsAllowanceSettings)
      .where(eq(smsAllowanceSettings.organisationId, input.organisationId))
      .for('update')
      .limit(1);
    if (settings === undefined) throw new Error('SMS_ALLOWANCE_SETTINGS_MISSING');

    const [existing] = await executor
      .select({
        id: smsUsageLedger.id,
        partDelta: smsUsageLedger.partDelta,
        billingPeriodStart: smsUsageLedger.billingPeriodStart,
        billingPeriodEnd: smsUsageLedger.billingPeriodEnd
      })
      .from(smsUsageLedger)
      .where(
        and(
          eq(smsUsageLedger.organisationId, input.organisationId),
          eq(smsUsageLedger.idempotencyKey, reservationKey(input.outboundMessageId))
        )
      )
      .limit(1);
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
            allowancePeriod.start
          )
        )
      );
    const usage = summariseSmsUsage(entries);
    const existingReservationMatches =
      existing !== undefined &&
      existing.partDelta === input.partCount &&
      existing.billingPeriodStart.getTime() ===
        allowancePeriod.start.getTime() &&
      existing.billingPeriodEnd.getTime() === allowancePeriod.end.getTime();
    const decision = decideSmsAllowance({
      ...usage,
      requestedParts: input.partCount,
      requestedPartsAlreadyReserved: existingReservationMatches,
      includedParts: settings.includedParts,
      warningPercent: settings.warningPercent,
      overageEnabled: settings.overageEnabled,
      overageCapCents: settings.overageCapCents,
      overageCentsPerPart: settings.overageCentsPerPart
    });
    if (decision.kind === 'blocked') return decision;
    if (existing !== undefined && !existingReservationMatches) {
      return {
        kind: 'blocked',
        reason: 'SMS_ALLOWANCE_EXHAUSTED',
        projectedParts: decision.projectedParts
      };
    }
    if (existing !== undefined) {
      return {
        kind: 'reserved',
        sourceNumber: number.e164Number,
        warningThresholdReached: false,
        alreadyReserved: true
      };
    }

    await executor.insert(smsUsageLedger).values({
      organisationId: input.organisationId,
      billingPeriodStart: allowancePeriod.start,
      billingPeriodEnd: allowancePeriod.end,
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
    if (entryType === 'COMMIT') {
      const [settings] = await executor
        .select({
          includedParts: smsAllowanceSettings.includedParts,
          overageEnabled: smsAllowanceSettings.overageEnabled,
          overageCentsPerPart: smsAllowanceSettings.overageCentsPerPart
        })
        .from(smsAllowanceSettings)
        .where(eq(smsAllowanceSettings.organisationId, organisationId))
        .for('update')
        .limit(1);
      if (settings === undefined) {
        throw new Error('SMS_ALLOWANCE_SETTINGS_MISSING');
      }
      const periodEntries = await executor
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
              reservation.billingPeriodStart
            )
          )
        );
      const usageAfterCommit = summariseSmsUsage(periodEntries);
      const billableParts = Math.max(
        0,
        usageAfterCommit.committedParts - settings.includedParts
      );
      if (billableParts > 0) {
        if (
          settings.overageEnabled !== true ||
          settings.overageCentsPerPart !== soloSmsOverageCentsPerPart
        ) {
          throw new Error('SMS_OVERAGE_BILLING_NOT_READY');
        }
        const [billingIdentity] = await executor
          .select({
            stripeCustomerId: subscriptions.stripeCustomerId,
            stripeSubscriptionId: subscriptions.stripeSubscriptionId
          })
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, organisationId))
          .for('update')
          .limit(1);
        if (
          billingIdentity?.stripeCustomerId === null ||
          billingIdentity?.stripeCustomerId === undefined ||
          billingIdentity.stripeSubscriptionId === null
        ) {
          throw new Error('SMS_OVERAGE_BILLING_NOT_READY');
        }
        await executor
          .insert(smsOverageStatements)
          .values({
            organisationId,
            stripeCustomerId: billingIdentity.stripeCustomerId,
            stripeSubscriptionId: billingIdentity.stripeSubscriptionId,
            billingPeriodStart: reservation.billingPeriodStart,
            billingPeriodEnd: reservation.billingPeriodEnd,
            committedParts: usageAfterCommit.committedParts,
            includedParts: settings.includedParts,
            billableParts,
            unitCents: soloSmsOverageCentsPerPart,
            subtotalCents: billableParts * soloSmsOverageCentsPerPart,
            status: 'OPEN',
            updatedAt: now
          })
          .onConflictDoUpdate({
            target: [
              smsOverageStatements.organisationId,
              smsOverageStatements.billingPeriodStart,
              smsOverageStatements.billingPeriodEnd
            ],
            set: {
              committedParts: usageAfterCommit.committedParts,
              includedParts: settings.includedParts,
              billableParts,
              unitCents: soloSmsOverageCentsPerPart,
              subtotalCents: billableParts * soloSmsOverageCentsPerPart,
              updatedAt: now
            }
          });
      }
    }
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
    let allowancePeriod: { start: Date; end: Date };
    try {
      allowancePeriod = monthlyAllowancePeriod({
        subscriptionPeriodStart: subscription.currentPeriodStart,
        subscriptionPeriodEnd: subscription.currentPeriodEnd,
        at: this.clock.now()
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'SMS_ALLOWANCE_PERIOD_INACTIVE'
      ) {
        return null;
      }
      throw error;
    }
    const effective = await this.loadAllowance(organisationId, executor);
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
            allowancePeriod.start
          )
        )
      );
    const usage = summariseSmsUsage(entries);
    const overageParts = Math.max(
      0,
      usage.committedParts + usage.reservedParts - effective.includedParts
    );
    return {
      billingPeriodStart: allowancePeriod.start,
      billingPeriodEnd: allowancePeriod.end,
      includedParts: effective.includedParts,
      warningPercent: effective.warningPercent,
      committedParts: usage.committedParts,
      reservedParts: usage.reservedParts,
      remainingParts: Math.max(
        0,
        effective.includedParts - usage.committedParts - usage.reservedParts
      ),
      overageParts,
      overageEnabled: effective.overageEnabled,
      overageCentsPerPart: effective.overageCentsPerPart,
      estimatedOverageCents:
        overageParts * (effective.overageCentsPerPart ?? 0)
    };
  }

  async loadAllowance(
    organisationId: string,
    executor: Executor = this.database
  ): Promise<SmsAllowanceView> {
    const [settings] = await executor
      .select({
        includedParts: smsAllowanceSettings.includedParts,
        warningPercent: smsAllowanceSettings.warningPercent,
        overageEnabled: smsAllowanceSettings.overageEnabled,
        overageCapCents: smsAllowanceSettings.overageCapCents,
        overageCentsPerPart: smsAllowanceSettings.overageCentsPerPart
      })
      .from(smsAllowanceSettings)
      .where(eq(smsAllowanceSettings.organisationId, organisationId))
      .limit(1);
    return settings === undefined
      ? {
          includedParts: soloIncludedSmsParts,
          warningPercent: 80,
          overageEnabled: true,
          overageCapCents: null,
          overageCentsPerPart: soloSmsOverageCentsPerPart
        }
      : {
          includedParts: settings.includedParts,
          warningPercent: settings.warningPercent,
          overageEnabled: settings.overageEnabled,
          overageCapCents: settings.overageCapCents,
          overageCentsPerPart: settings.overageCentsPerPart
        };
  }

  async claimDueOverageStatement(
    now: Date,
    processingStaleAfterMs: number,
    executor?: Executor
  ): Promise<SmsOverageStatement | null> {
    if (
      !Number.isSafeInteger(processingStaleAfterMs) ||
      processingStaleAfterMs < 1
    ) {
      throw new Error('SMS_OVERAGE_STALE_WINDOW_INVALID');
    }
    if (executor === undefined) {
      return this.database.transaction((transaction) =>
        this.claimDueOverageStatement(now, processingStaleAfterMs, transaction)
      );
    }
    const staleBefore = new Date(now.getTime() - processingStaleAfterMs);
    const [candidate] = await executor
      .select()
      .from(smsOverageStatements)
      .where(
        and(
          lte(smsOverageStatements.billingPeriodEnd, now),
          or(
            inArray(smsOverageStatements.status, ['OPEN', 'FAILED']),
            and(
              eq(smsOverageStatements.status, 'PROCESSING'),
              or(
                isNull(smsOverageStatements.lastAttemptAt),
                lte(smsOverageStatements.lastAttemptAt, staleBefore)
              )
            )
          )
        )
      )
      .orderBy(
        asc(smsOverageStatements.billingPeriodEnd),
        asc(smsOverageStatements.createdAt)
      )
      .for('update', { skipLocked: true })
      .limit(1);
    if (candidate === undefined) return null;

    const periodEntries = await executor
      .select({
        entryType: smsUsageLedger.entryType,
        partDelta: smsUsageLedger.partDelta
      })
      .from(smsUsageLedger)
      .where(
        and(
          eq(smsUsageLedger.organisationId, candidate.organisationId),
          eq(smsUsageLedger.billingPeriodStart, candidate.billingPeriodStart),
          eq(smsUsageLedger.billingPeriodEnd, candidate.billingPeriodEnd)
        )
      );
    if (summariseSmsUsage(periodEntries).reservedParts !== 0) return null;

    const [claimed] = await executor
      .update(smsOverageStatements)
      .set({
        status: 'PROCESSING',
        attemptCount: sql`${smsOverageStatements.attemptCount} + 1`,
        lastAttemptAt: now,
        lastErrorCode: null,
        updatedAt: now
      })
      .where(eq(smsOverageStatements.id, candidate.id))
      .returning();
    return claimed ?? null;
  }

  async markOverageStatementFailed(
    statementId: string,
    errorCode: string,
    now: Date,
    executor: Executor = this.database
  ): Promise<void> {
    if (!/^[A-Z0-9_]{1,64}$/.test(errorCode)) {
      throw new Error('SMS_OVERAGE_ERROR_CODE_INVALID');
    }
    const [updated] = await executor
      .update(smsOverageStatements)
      .set({ status: 'FAILED', lastErrorCode: errorCode, updatedAt: now })
      .where(
        and(
          eq(smsOverageStatements.id, statementId),
          eq(smsOverageStatements.status, 'PROCESSING')
        )
      )
      .returning({ id: smsOverageStatements.id });
    if (updated === undefined) throw new Error('SMS_OVERAGE_STATEMENT_NOT_PROCESSING');
  }

  async recordOverageInvoiceItem(
    statementId: string,
    stripeInvoiceItemId: string,
    now: Date,
    executor: Executor = this.database
  ): Promise<void> {
    if (
      stripeInvoiceItemId.trim() !== stripeInvoiceItemId ||
      stripeInvoiceItemId.length < 1 ||
      stripeInvoiceItemId.length > 128
    ) {
      throw new Error('SMS_OVERAGE_INVOICE_ITEM_INVALID');
    }
    const [updated] = await executor
      .update(smsOverageStatements)
      .set({ stripeInvoiceItemId, updatedAt: now })
      .where(
        and(
          eq(smsOverageStatements.id, statementId),
          eq(smsOverageStatements.status, 'PROCESSING'),
          or(
            isNull(smsOverageStatements.stripeInvoiceItemId),
            eq(smsOverageStatements.stripeInvoiceItemId, stripeInvoiceItemId)
          )
        )
      )
      .returning({ id: smsOverageStatements.id });
    if (updated === undefined) throw new Error('SMS_OVERAGE_INVOICE_ITEM_CONFLICT');
  }

  async recordOverageInvoice(
    statementId: string,
    stripeInvoiceId: string,
    now: Date,
    executor: Executor = this.database
  ): Promise<void> {
    if (
      stripeInvoiceId.trim() !== stripeInvoiceId ||
      stripeInvoiceId.length < 1 ||
      stripeInvoiceId.length > 128
    ) {
      throw new Error('SMS_OVERAGE_INVOICE_INVALID');
    }
    const [updated] = await executor
      .update(smsOverageStatements)
      .set({ stripeInvoiceId, updatedAt: now })
      .where(
        and(
          eq(smsOverageStatements.id, statementId),
          eq(smsOverageStatements.status, 'PROCESSING'),
          or(
            isNull(smsOverageStatements.stripeInvoiceId),
            eq(smsOverageStatements.stripeInvoiceId, stripeInvoiceId)
          )
        )
      )
      .returning({ id: smsOverageStatements.id });
    if (updated === undefined) throw new Error('SMS_OVERAGE_INVOICE_CONFLICT');
  }

  async markOverageStatementInvoiced(
    statementId: string,
    now: Date,
    executor: Executor = this.database
  ): Promise<void> {
    const [updated] = await executor
      .update(smsOverageStatements)
      .set({
        status: 'INVOICED',
        lastErrorCode: null,
        updatedAt: now
      })
      .where(
        and(
          eq(smsOverageStatements.id, statementId),
          eq(smsOverageStatements.status, 'PROCESSING'),
          isNotNull(smsOverageStatements.stripeInvoiceId),
          isNotNull(smsOverageStatements.stripeInvoiceItemId)
        )
      )
      .returning({ id: smsOverageStatements.id });
    if (updated === undefined) throw new Error('SMS_OVERAGE_INVOICE_NOT_READY');
  }

  async reserveAvailableNumber(
    organisationId: string,
    now: Date
  ): Promise<{ id: string; e164Number: string; status: 'RESERVED' | 'READY' }> {
    return this.database.transaction(async (transaction) => {
      await transaction.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId)).for('update').limit(1);
      const [subscription] = await transaction
        .select({ status: subscriptions.status, stripeProviderStatus: subscriptions.trustedStripeProviderStatus, currentPeriodEnd: subscriptions.currentPeriodEnd, cancelAt: subscriptions.cancelAt })
        .from(subscriptions)
        .where(eq(subscriptions.organisationId, organisationId))
        .for('update')
        .limit(1);
      if (
        subscription === undefined ||
        !hasPaidSubscriptionAccess({ subscriptionStatus: subscription.status, stripeProviderStatus: subscription.stripeProviderStatus, currentPeriodEnd: subscription.currentPeriodEnd, cancelAt: subscription.cancelAt, now: new Date(Math.max(now.getTime(), this.clock.now().getTime())) })
      ) {
        throw new Error('PAID_SUBSCRIPTION_REQUIRED');
      }
      const [activeProvisioningRequest] = await transaction
        .select({ id: replyNumberProvisioningRequests.id })
        .from(replyNumberProvisioningRequests)
        .where(
          and(
            eq(
              replyNumberProvisioningRequests.organisationId,
              organisationId
            ),
            inArray(replyNumberProvisioningRequests.status, [
              'AWAITING_QUOTE',
              'AWAITING_OWNER_APPROVAL',
              'APPROVED_FOR_MANUAL_ORDER',
              'MANUAL_ORDER_RECORDED'
            ])
          )
        )
        .limit(1);
      if (activeProvisioningRequest) {
        throw new Error('SMS_NUMBER_PROVISIONING_REQUEST_ACTIVE');
      }
      const [existing] = await transaction
        .select({
          id: smsNumberPool.id,
          e164Number: smsNumberPool.e164Number,
          status: smsNumberPool.status,
          provider: smsNumberPool.provider,
          providerNumberId: smsNumberPool.providerNumberId,
          providerVerifiedAt: smsNumberPool.providerVerifiedAt
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
        .for('update')
        .limit(1);
      if (existing !== undefined) {
        if (!hasPaidSubscriptionAccess({ subscriptionStatus: subscription.status, stripeProviderStatus: subscription.stripeProviderStatus, currentPeriodEnd: subscription.currentPeriodEnd, cancelAt: subscription.cancelAt, now: new Date(Math.max(now.getTime(), this.clock.now().getTime())) })) throw new Error('PAID_SUBSCRIPTION_REQUIRED');
        if (
          existing.status !== 'READY' &&
          (existing.provider !== 'SINCH' ||
            existing.providerNumberId === null ||
            existing.providerVerifiedAt === null)
        ) {
          throw new Error('SMS_NUMBER_NOT_VERIFIED');
        }
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
        .where(
          and(
            eq(smsNumberPool.status, 'AVAILABLE'),
            eq(smsNumberPool.provider, 'SINCH'),
            isNotNull(smsNumberPool.providerNumberId),
            isNotNull(smsNumberPool.providerVerifiedAt)
          )
        )
        .orderBy(asc(smsNumberPool.createdAt))
        .for('update')
        .limit(1);
      if (available === undefined) throw new Error('SMS_NUMBER_POOL_EXHAUSTED');
      if (!hasPaidSubscriptionAccess({ subscriptionStatus: subscription.status, stripeProviderStatus: subscription.stripeProviderStatus, currentPeriodEnd: subscription.currentPeriodEnd, cancelAt: subscription.cancelAt, now: new Date(Math.max(now.getTime(), this.clock.now().getTime())) })) throw new Error('PAID_SUBSCRIPTION_REQUIRED');
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
      await transaction.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId)).for('update').limit(1);
      const [subscription] = await transaction.select({ status: subscriptions.status, stripeProviderStatus: subscriptions.trustedStripeProviderStatus, currentPeriodEnd: subscriptions.currentPeriodEnd, cancelAt: subscriptions.cancelAt }).from(subscriptions).where(eq(subscriptions.organisationId, organisationId)).for('update').limit(1);
      if (subscription === undefined || !hasPaidSubscriptionAccess({ subscriptionStatus: subscription.status, stripeProviderStatus: subscription.stripeProviderStatus, currentPeriodEnd: subscription.currentPeriodEnd, cancelAt: subscription.cancelAt, now: new Date(Math.max(now.getTime(), this.clock.now().getTime())) })) throw new Error('PAID_SUBSCRIPTION_REQUIRED');
      const [reserved] = await transaction
        .select({
          provider: smsNumberPool.provider,
          providerNumberId: smsNumberPool.providerNumberId,
          providerVerifiedAt: smsNumberPool.providerVerifiedAt
        })
        .from(smsNumberPool)
        .where(
          and(
            eq(smsNumberPool.id, numberId),
            eq(smsNumberPool.organisationId, organisationId),
            eq(smsNumberPool.status, 'RESERVED')
          )
        )
        .for('update')
        .limit(1);
      if (reserved === undefined) {
        throw new Error('SMS_NUMBER_RESERVATION_NOT_FOUND');
      }
      if (!hasPaidSubscriptionAccess({ subscriptionStatus: subscription.status, stripeProviderStatus: subscription.stripeProviderStatus, currentPeriodEnd: subscription.currentPeriodEnd, cancelAt: subscription.cancelAt, now: new Date(Math.max(now.getTime(), this.clock.now().getTime())) })) throw new Error('PAID_SUBSCRIPTION_REQUIRED');
      if (
        reserved.provider !== 'SINCH' ||
        reserved.providerNumberId === null ||
        reserved.providerVerifiedAt === null
      ) {
        throw new Error('SMS_NUMBER_NOT_VERIFIED');
      }
      const updated = await transaction
        .update(smsNumberPool)
        .set({ status: 'READY', readyAt: now, updatedAt: now })
        .where(
          and(
            eq(smsNumberPool.id, numberId),
            eq(smsNumberPool.organisationId, organisationId),
            eq(smsNumberPool.status, 'RESERVED'),
            eq(smsNumberPool.provider, 'SINCH'),
            isNotNull(smsNumberPool.providerNumberId),
            isNotNull(smsNumberPool.providerVerifiedAt)
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
      await transaction.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId)).for('update').limit(1);
      await transaction.select({ organisationId: subscriptions.organisationId }).from(subscriptions).where(eq(subscriptions.organisationId, organisationId)).for('update').limit(1);
      const quarantined = await transaction
        .update(smsNumberPool)
        .set({
          status: 'QUARANTINED',
          quarantineUntil,
          updatedAt: now
        })
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
