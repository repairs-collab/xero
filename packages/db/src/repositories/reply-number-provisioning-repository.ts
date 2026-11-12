import { and, desc, eq, inArray } from 'drizzle-orm';

import { hasPaidSubscriptionAccess } from '@bc5000/domain';

import type { Database, DbTransaction } from '../connection.js';
import {
  billingCases,
  organisations,
  platformAdminAuditEvents,
  replyNumberProvisioningRequests,
  smsNumberPool,
  subscriptions,
  users,
  type ReplyNumberDocumentationStatus,
  type ReplyNumberProvisioningRequest
} from '../schema/index.js';

const activeRequestStatuses = [
  'AWAITING_QUOTE',
  'AWAITING_OWNER_APPROVAL',
  'APPROVED_FOR_MANUAL_ORDER',
  'MANUAL_ORDER_RECORDED'
] as const;

const activeNumberStatuses = ['RESERVED', 'READY', 'QUARANTINED'] as const;

export type OrganisationReplyNumberProvisioningState =
  | {
      kind: 'ASSIGNED_READY';
      numberId: string;
      e164Number: string;
    }
  | {
      kind: 'ASSIGNED_RESERVED';
      numberId: string;
      e164Number: string;
    }
  | {
      kind: 'ASSIGNED_QUARANTINED';
      numberId: string;
      e164Number: string;
    }
  | {
      kind: 'ACTIVE_REQUEST';
      requestId: string;
      status: (typeof activeRequestStatuses)[number];
    }
  | { kind: 'NONE' };

export type ReplyNumberProvisioningFailureCode =
  | 'NOT_FOUND'
  | 'NOT_OWNER'
  | 'NOT_ELIGIBLE'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'VALIDATION'
  | 'BILLING_RISK_HOLD'
  | 'QUOTE_EXPIRED'
  | 'AMOUNT_MISMATCH'
  | 'NUMBER_CONFLICT';

export type ReplyNumberProvisioningResult =
  | { ok: true; value: ReplyNumberProvisioningRequest }
  | { ok: false; code: ReplyNumberProvisioningFailureCode };

export interface EnsureReplyNumberRequestInput {
  organisationId: string;
  provider: string;
  now: Date;
}

export interface RecordReplyNumberQuoteInput {
  actorUserId: string;
  organisationId: string;
  requestId: string;
  expectedVersion: number;
  setupFeeMinor: number;
  monthlyFeeMinor: number;
  currency: 'aud';
  quoteExpiresAt: Date;
  documentationStatus: Exclude<ReplyNumberDocumentationStatus, 'UNKNOWN'>;
  documentationEvidenceReference: string | null;
  reason: string;
  now: Date;
}

export interface ApproveManualReplyNumberOrderInput {
  actorUserId: string;
  organisationId: string;
  requestId: string;
  expectedVersion: number;
  confirmedSetupFeeMinor: number;
  confirmedMonthlyFeeMinor: number;
  reason: string;
  now: Date;
}

export interface RecordManualReplyNumberOrderInput {
  actorUserId: string;
  organisationId: string;
  requestId: string;
  expectedVersion: number;
  externalOrderReference: string;
  reason: string;
  now: Date;
}

export interface RecordReplyNumberDocumentationInput {
  actorUserId: string;
  organisationId: string;
  requestId: string;
  expectedVersion: number;
  documentationEvidenceReference: string;
  reason: string;
  now: Date;
}

export interface RecordFulfilledReplyNumberInput {
  actorUserId: string;
  organisationId: string;
  requestId: string;
  expectedVersion: number;
  e164Number: string;
  providerNumberId: string;
  reason: string;
  now: Date;
}

export interface TerminateReplyNumberRequestInput {
  actorUserId: string;
  organisationId: string;
  requestId: string;
  expectedVersion: number;
  reason: string;
  now: Date;
}

export interface FailReplyNumberRequestInput
  extends TerminateReplyNumberRequestInput {
  failureCode: string;
}

const isSafeMinorAmount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;

const cleanReason = (reason: string): string | null => {
  const value = reason.trim();
  return value.length > 0 && value.length <= 500 ? value : null;
};

const cleanReference = (reference: string, maximumLength: number): string | null => {
  const value = reference.trim();
  return value.length > 0 && value.length <= maximumLength && !/[\r\n\0]/u.test(value)
    ? value
    : null;
};

const cleanOpaqueReference = (
  reference: string,
  maximumLength: number
): string | null => {
  const value = reference.trim();
  return value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    ? value
    : null;
};

const validDate = (value: Date): boolean => Number.isFinite(value.getTime());

const isOwner = async (
  transaction: DbTransaction,
  actorUserId: string
): Promise<boolean> => {
  const [actor] = await transaction
    .select({ platformRole: users.platformRole, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  return actor?.platformRole === 'OWNER' && actor.disabledAt === null;
};

const lockOrganisation = async (
  transaction: DbTransaction,
  organisationId: string
) => {
  const [organisation] = await transaction
    .select({
      id: organisations.id,
      edition: organisations.edition,
      platformStatus: organisations.platformStatus
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for('update')
    .limit(1);
  return organisation ?? null;
};

const lockRequest = async (
  transaction: DbTransaction,
  organisationId: string,
  requestId: string
) => {
  const [request] = await transaction
    .select()
    .from(replyNumberProvisioningRequests)
    .where(
      and(
        eq(replyNumberProvisioningRequests.id, requestId),
        eq(replyNumberProvisioningRequests.organisationId, organisationId)
      )
    )
    .for('update')
    .limit(1);
  return request ?? null;
};

const hasActiveNumber = async (
  transaction: DbTransaction,
  organisationId: string
): Promise<boolean> => {
  const [number] = await transaction
    .select({ id: smsNumberPool.id })
    .from(smsNumberPool)
    .where(
      and(
        eq(smsNumberPool.organisationId, organisationId),
        inArray(smsNumberPool.status, activeNumberStatuses)
      )
    )
    .limit(1);
  return number !== undefined;
};

const postgresErrorCode = (error: unknown): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    if (typeof current !== 'object') return null;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return null;
};

const isUniqueViolation = (error: unknown): boolean =>
  postgresErrorCode(error) === '23505';

export class PostgresReplyNumberProvisioningRepository {
  constructor(private readonly database: Database) {}

  async loadOrganisationProvisioningState(
    organisationId: string
  ): Promise<OrganisationReplyNumberProvisioningState> {
    const [number] = await this.database
      .select({
        id: smsNumberPool.id,
        e164Number: smsNumberPool.e164Number,
        status: smsNumberPool.status
      })
      .from(smsNumberPool)
      .where(
        and(
          eq(smsNumberPool.organisationId, organisationId),
          inArray(smsNumberPool.status, activeNumberStatuses)
        )
      )
      .limit(1);
    if (number) {
      return {
        kind:
          number.status === 'READY'
            ? 'ASSIGNED_READY'
            : number.status === 'RESERVED'
              ? 'ASSIGNED_RESERVED'
              : 'ASSIGNED_QUARANTINED',
        numberId: number.id,
        e164Number: number.e164Number
      };
    }

    const [request] = await this.database
      .select({
        id: replyNumberProvisioningRequests.id,
        status: replyNumberProvisioningRequests.status
      })
      .from(replyNumberProvisioningRequests)
      .where(
        and(
          eq(replyNumberProvisioningRequests.organisationId, organisationId),
          inArray(replyNumberProvisioningRequests.status, activeRequestStatuses)
        )
      )
      .limit(1);
    return request
      ? {
          kind: 'ACTIVE_REQUEST',
          requestId: request.id,
          status: request.status as (typeof activeRequestStatuses)[number]
        }
      : { kind: 'NONE' };
  }

  async ensureRequestForPaidOrganisation(
    input: EnsureReplyNumberRequestInput
  ): Promise<ReplyNumberProvisioningResult> {
    const provider = input.provider.trim();
    if (
      !/^[A-Z][A-Z0-9_-]{1,31}$/u.test(provider) ||
      !validDate(input.now)
    ) {
      return { ok: false, code: 'VALIDATION' };
    }

    try {
      return await this.database.transaction(async (transaction) => {
        const organisation = await lockOrganisation(
          transaction,
          input.organisationId
        );
        if (
          !organisation ||
          organisation.edition !== 'SOLO' ||
          organisation.platformStatus !== 'ACTIVE'
        ) {
          return { ok: false, code: 'NOT_ELIGIBLE' } as const;
        }
        const [subscription] = await transaction
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organisationId, input.organisationId))
          .for('update')
          .limit(1);
        if (
          !subscription ||
          subscription.trustedStripeProviderStatus !== 'active' ||
          !subscription.currentPeriodStart ||
          !subscription.currentPeriodEnd ||
          subscription.currentPeriodStart.getTime() > input.now.getTime() ||
          subscription.currentPeriodEnd.getTime() <= input.now.getTime() ||
          !hasPaidSubscriptionAccess({
            subscriptionStatus: subscription.status,
            stripeProviderStatus: subscription.trustedStripeProviderStatus,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAt: subscription.cancelAt,
            now: input.now
          })
        ) {
          return { ok: false, code: 'NOT_ELIGIBLE' } as const;
        }

        const [existing] = await transaction
          .select()
          .from(replyNumberProvisioningRequests)
          .where(
            and(
              eq(
                replyNumberProvisioningRequests.organisationId,
                input.organisationId
              ),
              inArray(
                replyNumberProvisioningRequests.status,
                activeRequestStatuses
              )
            )
          )
          .limit(1);
        if (existing) {
          return existing.provider === provider
            ? ({ ok: true, value: existing } as const)
            : ({ ok: false, code: 'CONFLICT' } as const);
        }
        if (await hasActiveNumber(transaction, input.organisationId)) {
          return { ok: false, code: 'NOT_ELIGIBLE' } as const;
        }

        const [previous] = await transaction
          .select({ attempt: replyNumberProvisioningRequests.attempt })
          .from(replyNumberProvisioningRequests)
          .where(
            eq(
              replyNumberProvisioningRequests.organisationId,
              input.organisationId
            )
          )
          .orderBy(desc(replyNumberProvisioningRequests.attempt))
          .limit(1);
        const attempt = (previous?.attempt ?? 0) + 1;
        const [created] = await transaction
          .insert(replyNumberProvisioningRequests)
          .values({
            organisationId: input.organisationId,
            provider,
            requestKey: `reply-number:${input.organisationId}:${attempt}`,
            attempt,
            version: 1,
            status: 'AWAITING_QUOTE',
            createdAt: input.now,
            updatedAt: input.now
          })
          .returning();
        if (!created) throw new Error('Reply-number request insert returned no row');
        return { ok: true, value: created } as const;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [existing] = await this.database
        .select()
        .from(replyNumberProvisioningRequests)
        .where(
          and(
            eq(
              replyNumberProvisioningRequests.organisationId,
              input.organisationId
            ),
            inArray(
              replyNumberProvisioningRequests.status,
              activeRequestStatuses
            )
          )
        )
        .limit(1);
      return existing?.provider === provider
        ? { ok: true, value: existing }
        : { ok: false, code: 'CONFLICT' };
    }
  }

  async recordQuote(
    input: RecordReplyNumberQuoteInput
  ): Promise<ReplyNumberProvisioningResult> {
    const reason = cleanReason(input.reason);
    const evidenceReference = input.documentationEvidenceReference
      ? cleanOpaqueReference(input.documentationEvidenceReference, 128)
      : null;
    if (
      !reason ||
      !isSafeMinorAmount(input.setupFeeMinor) ||
      !isSafeMinorAmount(input.monthlyFeeMinor) ||
      input.currency !== 'aud' ||
      !validDate(input.now) ||
      !validDate(input.quoteExpiresAt) ||
      input.quoteExpiresAt.getTime() <= input.now.getTime() ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      (input.documentationStatus === 'COMPLETE' && !evidenceReference) ||
      (input.documentationEvidenceReference !== null && !evidenceReference)
    ) {
      return { ok: false, code: 'VALIDATION' };
    }

    return this.database.transaction(async (transaction) => {
      if (!(await isOwner(transaction, input.actorUserId))) {
        return { ok: false, code: 'NOT_OWNER' } as const;
      }
      if (!(await lockOrganisation(transaction, input.organisationId))) {
        return { ok: false, code: 'NOT_FOUND' } as const;
      }
      const request = await lockRequest(
        transaction,
        input.organisationId,
        input.requestId
      );
      if (!request) return { ok: false, code: 'NOT_FOUND' } as const;
      if (request.version !== input.expectedVersion) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (request.status !== 'AWAITING_QUOTE') {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }

      const [updated] = await transaction
        .update(replyNumberProvisioningRequests)
        .set({
          status: 'AWAITING_OWNER_APPROVAL',
          quoteSetupFeeMinor: input.setupFeeMinor,
          quoteMonthlyFeeMinor: input.monthlyFeeMinor,
          quoteCurrency: 'aud',
          quoteExpiresAt: input.quoteExpiresAt,
          quotedAt: input.now,
          documentationStatus: input.documentationStatus,
          documentationEvidenceReference: evidenceReference,
          version: request.version + 1,
          updatedAt: input.now
        })
        .where(eq(replyNumberProvisioningRequests.id, request.id))
        .returning();
      if (!updated) throw new Error('Reply-number quote update returned no row');
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: 'REPLY_NUMBER_QUOTE_RECORDED',
        entityType: 'REPLY_NUMBER_PROVISIONING_REQUEST',
        entityId: request.id,
        reason,
        beforeValue: { status: request.status, version: request.version },
        afterValue: {
          status: updated.status,
          version: updated.version,
          provider: updated.provider,
          setupFeeMinor: input.setupFeeMinor,
          monthlyFeeMinor: input.monthlyFeeMinor,
          currency: 'aud',
          quoteExpiresAt: input.quoteExpiresAt.toISOString(),
          documentationStatus: input.documentationStatus,
          documentationEvidenceReferencePresent: evidenceReference !== null
        },
        occurredAt: input.now
      });
      return { ok: true, value: updated } as const;
    });
  }

  async recordDocumentationComplete(
    input: RecordReplyNumberDocumentationInput
  ): Promise<ReplyNumberProvisioningResult> {
    const reason = cleanReason(input.reason);
    const evidenceReference = cleanOpaqueReference(
      input.documentationEvidenceReference,
      128
    );
    if (
      !reason ||
      !evidenceReference ||
      !validDate(input.now) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return { ok: false, code: 'VALIDATION' };
    }

    return this.database.transaction(async (transaction) => {
      if (!(await isOwner(transaction, input.actorUserId))) {
        return { ok: false, code: 'NOT_OWNER' } as const;
      }
      if (!(await lockOrganisation(transaction, input.organisationId))) {
        return { ok: false, code: 'NOT_FOUND' } as const;
      }
      const request = await lockRequest(
        transaction,
        input.organisationId,
        input.requestId
      );
      if (!request) return { ok: false, code: 'NOT_FOUND' } as const;
      if (request.version !== input.expectedVersion) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (
        request.documentationStatus !== 'REQUIRED' ||
        !['AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER'].includes(
          request.status
        )
      ) {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }

      const [updated] = await transaction
        .update(replyNumberProvisioningRequests)
        .set({
          documentationStatus: 'COMPLETE',
          documentationEvidenceReference: evidenceReference,
          version: request.version + 1,
          updatedAt: input.now
        })
        .where(eq(replyNumberProvisioningRequests.id, request.id))
        .returning();
      if (!updated) {
        throw new Error('Reply-number documentation update returned no row');
      }
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: 'REPLY_NUMBER_DOCUMENTATION_COMPLETED',
        entityType: 'REPLY_NUMBER_PROVISIONING_REQUEST',
        entityId: request.id,
        reason,
        beforeValue: {
          status: request.status,
          version: request.version,
          documentationStatus: request.documentationStatus
        },
        afterValue: {
          status: updated.status,
          version: updated.version,
          documentationStatus: updated.documentationStatus,
          documentationEvidenceReferencePresent: true
        },
        occurredAt: input.now
      });
      return { ok: true, value: updated } as const;
    });
  }

  async approveManualOrder(
    input: ApproveManualReplyNumberOrderInput
  ): Promise<ReplyNumberProvisioningResult> {
    const reason = cleanReason(input.reason);
    if (
      !reason ||
      !isSafeMinorAmount(input.confirmedSetupFeeMinor) ||
      !isSafeMinorAmount(input.confirmedMonthlyFeeMinor) ||
      !validDate(input.now) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return { ok: false, code: 'VALIDATION' };
    }

    return this.database.transaction(async (transaction) => {
      if (!(await isOwner(transaction, input.actorUserId))) {
        return { ok: false, code: 'NOT_OWNER' } as const;
      }
      const organisation = await lockOrganisation(
        transaction,
        input.organisationId
      );
      if (!organisation) return { ok: false, code: 'NOT_FOUND' } as const;
      const [subscription] = await transaction
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organisationId, input.organisationId))
        .for('update')
        .limit(1);
      const request = await lockRequest(
        transaction,
        input.organisationId,
        input.requestId
      );
      if (!request) return { ok: false, code: 'NOT_FOUND' } as const;
      if (request.version !== input.expectedVersion) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (request.status !== 'AWAITING_OWNER_APPROVAL') {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }
      if (
        organisation.edition !== 'SOLO' ||
        organisation.platformStatus !== 'ACTIVE' ||
        !subscription ||
        subscription.status !== 'ACTIVE' ||
        subscription.trustedStripeProviderStatus !== 'active' ||
        !subscription.currentPeriodStart ||
        !subscription.currentPeriodEnd ||
        subscription.currentPeriodStart.getTime() > input.now.getTime() ||
        subscription.currentPeriodEnd.getTime() <= input.now.getTime()
      ) {
        return { ok: false, code: 'NOT_ELIGIBLE' } as const;
      }
      const [blockingCase] = await transaction
        .select({ id: billingCases.id })
        .from(billingCases)
        .where(
          and(
            eq(billingCases.organisationId, input.organisationId),
            eq(billingCases.blocksSending, true),
            inArray(billingCases.status, ['OPEN', 'REVIEW_REQUIRED'])
          )
        )
        .limit(1);
      if (blockingCase) {
        return { ok: false, code: 'BILLING_RISK_HOLD' } as const;
      }
      if (await hasActiveNumber(transaction, input.organisationId)) {
        return { ok: false, code: 'NUMBER_CONFLICT' } as const;
      }
      if (
        !request.quoteExpiresAt ||
        request.quoteExpiresAt.getTime() <= input.now.getTime()
      ) {
        return { ok: false, code: 'QUOTE_EXPIRED' } as const;
      }
      if (
        request.quoteSetupFeeMinor !== input.confirmedSetupFeeMinor ||
        request.quoteMonthlyFeeMinor !== input.confirmedMonthlyFeeMinor
      ) {
        return { ok: false, code: 'AMOUNT_MISMATCH' } as const;
      }

      const [updated] = await transaction
        .update(replyNumberProvisioningRequests)
        .set({
          status: 'APPROVED_FOR_MANUAL_ORDER',
          approvedByUserId: input.actorUserId,
          approvedAt: input.now,
          approvalReason: reason,
          version: request.version + 1,
          updatedAt: input.now
        })
        .where(eq(replyNumberProvisioningRequests.id, request.id))
        .returning();
      if (!updated) throw new Error('Reply-number approval update returned no row');
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: 'REPLY_NUMBER_MANUAL_ORDER_APPROVED',
        entityType: 'REPLY_NUMBER_PROVISIONING_REQUEST',
        entityId: request.id,
        reason,
        beforeValue: { status: request.status, version: request.version },
        afterValue: {
          status: updated.status,
          version: updated.version,
          setupFeeMinor: request.quoteSetupFeeMinor,
          monthlyFeeMinor: request.quoteMonthlyFeeMinor,
          currency: request.quoteCurrency,
          quoteExpiresAt: request.quoteExpiresAt.toISOString()
        },
        occurredAt: input.now
      });
      return { ok: true, value: updated } as const;
    });
  }

  async recordManualOrderReference(
    input: RecordManualReplyNumberOrderInput
  ): Promise<ReplyNumberProvisioningResult> {
    const reason = cleanReason(input.reason);
    const externalOrderReference = cleanOpaqueReference(
      input.externalOrderReference,
      128
    );
    if (
      !reason ||
      !externalOrderReference ||
      !validDate(input.now) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return { ok: false, code: 'VALIDATION' };
    }

    return this.database.transaction(async (transaction) => {
      if (!(await isOwner(transaction, input.actorUserId))) {
        return { ok: false, code: 'NOT_OWNER' } as const;
      }
      if (!(await lockOrganisation(transaction, input.organisationId))) {
        return { ok: false, code: 'NOT_FOUND' } as const;
      }
      const request = await lockRequest(
        transaction,
        input.organisationId,
        input.requestId
      );
      if (!request) return { ok: false, code: 'NOT_FOUND' } as const;
      if (request.version !== input.expectedVersion) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (request.status !== 'APPROVED_FOR_MANUAL_ORDER') {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }
      if (
        !request.quoteExpiresAt ||
        request.quoteExpiresAt.getTime() <= input.now.getTime()
      ) {
        return { ok: false, code: 'QUOTE_EXPIRED' } as const;
      }
      if (
        request.documentationStatus !== 'NOT_REQUIRED' &&
        !(
          request.documentationStatus === 'COMPLETE' &&
          request.documentationEvidenceReference
        )
      ) {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }
      if (await hasActiveNumber(transaction, input.organisationId)) {
        return { ok: false, code: 'NUMBER_CONFLICT' } as const;
      }

      const [updated] = await transaction
        .update(replyNumberProvisioningRequests)
        .set({
          status: 'MANUAL_ORDER_RECORDED',
          externalOrderReference,
          manualOrderRecordedAt: input.now,
          version: request.version + 1,
          updatedAt: input.now
        })
        .where(eq(replyNumberProvisioningRequests.id, request.id))
        .returning();
      if (!updated) throw new Error('Reply-number order update returned no row');
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: 'REPLY_NUMBER_MANUAL_ORDER_RECORDED',
        entityType: 'REPLY_NUMBER_PROVISIONING_REQUEST',
        entityId: request.id,
        reason,
        beforeValue: { status: request.status, version: request.version },
        afterValue: {
          status: updated.status,
          version: updated.version,
          externalOrderReferencePresent: true
        },
        occurredAt: input.now
      });
      return { ok: true, value: updated } as const;
    });
  }

  async recordFulfilledNumber(
    input: RecordFulfilledReplyNumberInput
  ): Promise<ReplyNumberProvisioningResult> {
    const reason = cleanReason(input.reason);
    const providerNumberId = cleanReference(input.providerNumberId, 128);
    if (
      !reason ||
      !providerNumberId ||
      !/^[+]61[0-9]{9}$/u.test(input.e164Number) ||
      !validDate(input.now) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return { ok: false, code: 'VALIDATION' };
    }

    try {
      return await this.database.transaction(async (transaction) => {
        if (!(await isOwner(transaction, input.actorUserId))) {
          return { ok: false, code: 'NOT_OWNER' } as const;
        }
        if (!(await lockOrganisation(transaction, input.organisationId))) {
          return { ok: false, code: 'NOT_FOUND' } as const;
        }
        const request = await lockRequest(
          transaction,
          input.organisationId,
          input.requestId
        );
        if (!request) return { ok: false, code: 'NOT_FOUND' } as const;
        if (request.version !== input.expectedVersion) {
          return { ok: false, code: 'CONFLICT' } as const;
        }
        if (request.status !== 'MANUAL_ORDER_RECORDED') {
          return { ok: false, code: 'INVALID_STATE' } as const;
        }
        if (await hasActiveNumber(transaction, input.organisationId)) {
          return { ok: false, code: 'NUMBER_CONFLICT' } as const;
        }

        const [number] = await transaction
          .insert(smsNumberPool)
          .values({
            e164Number: input.e164Number,
            provider: request.provider,
            providerNumberId,
            providerVerifiedAt: null,
            status: 'RESERVED',
            organisationId: input.organisationId,
            reservedAt: input.now,
            createdAt: input.now,
            updatedAt: input.now
          })
          .returning({ id: smsNumberPool.id });
        if (!number) throw new Error('Reply number insert returned no row');

        const [updated] = await transaction
          .update(replyNumberProvisioningRequests)
          .set({
            status: 'FULFILLED',
            fulfilledNumberId: number.id,
            version: request.version + 1,
            updatedAt: input.now
          })
          .where(eq(replyNumberProvisioningRequests.id, request.id))
          .returning();
        if (!updated) throw new Error('Reply-number fulfilment update returned no row');
        await transaction.insert(platformAdminAuditEvents).values({
          actorUserId: input.actorUserId,
          targetOrganisationId: input.organisationId,
          eventType: 'REPLY_NUMBER_MANUAL_ORDER_FULFILLED',
          entityType: 'REPLY_NUMBER_PROVISIONING_REQUEST',
          entityId: request.id,
          reason,
          beforeValue: { status: request.status, version: request.version },
          afterValue: {
            status: updated.status,
            version: updated.version,
            numberId: number.id,
            numberLast4: input.e164Number.slice(-4),
            provider: request.provider,
            providerNumberIdPresent: true,
            numberStatus: 'RESERVED'
          },
          occurredAt: input.now
        });
        return { ok: true, value: updated } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { ok: false, code: 'NUMBER_CONFLICT' };
      }
      throw error;
    }
  }

  async failRequest(
    input: FailReplyNumberRequestInput
  ): Promise<ReplyNumberProvisioningResult> {
    const reason = cleanReason(input.reason);
    const failureCode = cleanReference(input.failureCode, 64);
    if (
      !reason ||
      !failureCode ||
      !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(failureCode) ||
      !validDate(input.now) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return { ok: false, code: 'VALIDATION' };
    }
    return this.terminateRequest({
      ...input,
      reason,
      targetStatus: 'FAILED',
      failureCode
    });
  }

  async expireRequest(
    input: TerminateReplyNumberRequestInput
  ): Promise<ReplyNumberProvisioningResult> {
    const reason = cleanReason(input.reason);
    if (
      !reason ||
      !validDate(input.now) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return { ok: false, code: 'VALIDATION' };
    }
    return this.terminateRequest({
      ...input,
      reason,
      targetStatus: 'EXPIRED',
      failureCode: null
    });
  }

  private async terminateRequest(
    input: TerminateReplyNumberRequestInput & {
      targetStatus: 'FAILED' | 'EXPIRED';
      failureCode: string | null;
    }
  ): Promise<ReplyNumberProvisioningResult> {
    return this.database.transaction(async (transaction) => {
      if (!(await isOwner(transaction, input.actorUserId))) {
        return { ok: false, code: 'NOT_OWNER' } as const;
      }
      if (!(await lockOrganisation(transaction, input.organisationId))) {
        return { ok: false, code: 'NOT_FOUND' } as const;
      }
      const request = await lockRequest(
        transaction,
        input.organisationId,
        input.requestId
      );
      if (!request) return { ok: false, code: 'NOT_FOUND' } as const;
      if (request.version !== input.expectedVersion) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (!activeRequestStatuses.includes(request.status as (typeof activeRequestStatuses)[number])) {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }
      if (
        input.targetStatus === 'EXPIRED' &&
        (!['AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER'].includes(
          request.status
        ) ||
          !request.quoteExpiresAt ||
          request.quoteExpiresAt.getTime() > input.now.getTime())
      ) {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }

      const [updated] = await transaction
        .update(replyNumberProvisioningRequests)
        .set({
          status: input.targetStatus,
          failureCode: input.failureCode,
          failedAt: input.targetStatus === 'FAILED' ? input.now : null,
          expiredAt: input.targetStatus === 'EXPIRED' ? input.now : null,
          version: request.version + 1,
          updatedAt: input.now
        })
        .where(eq(replyNumberProvisioningRequests.id, request.id))
        .returning();
      if (!updated) throw new Error('Reply-number terminal update returned no row');
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType:
          input.targetStatus === 'FAILED'
            ? 'REPLY_NUMBER_REQUEST_FAILED'
            : 'REPLY_NUMBER_REQUEST_EXPIRED',
        entityType: 'REPLY_NUMBER_PROVISIONING_REQUEST',
        entityId: request.id,
        reason: input.reason,
        beforeValue: { status: request.status, version: request.version },
        afterValue: {
          status: updated.status,
          version: updated.version,
          failureCode: input.failureCode
        },
        occurredAt: input.now
      });
      return { ok: true, value: updated } as const;
    });
  }
}
