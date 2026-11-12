import { AuthorizationFailure } from '@bc5000/auth';
import { and, desc, eq } from 'drizzle-orm';

import {
  auditEvents,
  dataRequestCases,
  organisations,
  retentionCases,
  type DataRequestType,
  type Database
} from '@bc5000/db';
import { dataRequestReviewDecision } from '@bc5000/domain';

export interface RetentionMutationResult {
  ok: boolean;
  code?: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT';
  value?: unknown;
}

export interface RetentionOperationsPage {
  retentionCases: Array<{
    organisationId: string;
    organisationName: string;
    source: string;
    status: string;
    reviewAfter: Date;
    deletionEligibleAt: Date | null;
    backupExpiryVerifiedAt: Date | null;
    backupExpiryEvidenceReference: string | null;
    updatedAt: Date;
  }>;
  dataRequests: Array<{
    id: string;
    organisationId: string;
    organisationName: string;
    requestType: DataRequestType;
    status: string;
    verificationReference: string;
    verifiedAt: Date;
    targetAt: Date;
    version: number;
    blockReason: string | null;
    lastReviewedAt: Date | null;
    updatedAt: Date;
  }>;
}

export interface RetentionOperationsRepository {
  listOperations(input: {
    organisationId?: string;
  }): Promise<RetentionOperationsPage>;
  recordVerifiedRequest(input: {
    actorUserId: string;
    organisationId: string;
    requestType: DataRequestType;
    verificationReference: string;
    idempotencyKey: string;
    verifiedAt: Date;
    targetAt: Date;
    now: Date;
  }): Promise<RetentionMutationResult>;
  reviewDataRequest(input: {
    actorUserId: string;
    organisationId: string;
    requestId: string;
    expectedVersion: number;
    reason: string;
    now: Date;
  }): Promise<RetentionMutationResult>;
  recordBackupExpiryVerification(input: {
    actorUserId: string;
    organisationId: string;
    verifiedAt: Date;
    evidenceReference: string;
    expectedUpdatedAt: Date;
    reason: string;
    now: Date;
  }): Promise<RetentionMutationResult>;
}

export class PostgresRetentionOperationsRepository
  implements RetentionOperationsRepository
{
  constructor(private readonly database: Database) {}

  async listOperations(input: {
    organisationId?: string;
  }): Promise<RetentionOperationsPage> {
    const retentionFilter = input.organisationId
      ? eq(retentionCases.organisationId, input.organisationId)
      : undefined;
    const requestFilter = input.organisationId
      ? eq(dataRequestCases.organisationId, input.organisationId)
      : undefined;
    const [retentionRows, requestRows] = await Promise.all([
      this.database
        .select({
          organisationId: retentionCases.organisationId,
          organisationName: organisations.name,
          source: retentionCases.source,
          status: retentionCases.status,
          reviewAfter: retentionCases.reviewAfter,
          deletionEligibleAt: retentionCases.deletionEligibleAt,
          backupExpiryVerifiedAt: retentionCases.backupExpiryVerifiedAt,
          backupExpiryEvidenceReference:
            retentionCases.backupExpiryEvidenceReference,
          updatedAt: retentionCases.updatedAt
        })
        .from(retentionCases)
        .innerJoin(
          organisations,
          eq(organisations.id, retentionCases.organisationId)
        )
        .where(retentionFilter)
        .orderBy(desc(retentionCases.updatedAt))
        .limit(100),
      this.database
        .select({
          id: dataRequestCases.id,
          organisationId: dataRequestCases.organisationId,
          organisationName: organisations.name,
          requestType: dataRequestCases.requestType,
          status: dataRequestCases.status,
          verificationReference: dataRequestCases.verificationReference,
          verifiedAt: dataRequestCases.verifiedAt,
          targetAt: dataRequestCases.targetAt,
          version: dataRequestCases.version,
          blockReason: dataRequestCases.blockReason,
          lastReviewedAt: dataRequestCases.lastReviewedAt,
          updatedAt: dataRequestCases.updatedAt
        })
        .from(dataRequestCases)
        .innerJoin(
          organisations,
          eq(organisations.id, dataRequestCases.organisationId)
        )
        .where(requestFilter)
        .orderBy(desc(dataRequestCases.targetAt), desc(dataRequestCases.id))
        .limit(100)
    ]);
    return { retentionCases: retentionRows, dataRequests: requestRows };
  }

  async recordVerifiedRequest(
    input: Parameters<RetentionOperationsRepository['recordVerifiedRequest']>[0]
  ): Promise<RetentionMutationResult> {
    return this.database.transaction(async (transaction) => {
      const [organisation] = await transaction
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .limit(1);
      if (organisation === undefined) return { ok: false, code: 'NOT_FOUND' };

      const [inserted] = await transaction
        .insert(dataRequestCases)
        .values({
          organisationId: input.organisationId,
          requestType: input.requestType,
          verificationReference: input.verificationReference,
          idempotencyKey: input.idempotencyKey,
          verifiedAt: input.verifiedAt,
          targetAt: input.targetAt,
          createdAt: input.now,
          updatedAt: input.now
        })
        .onConflictDoNothing({
          target: [
            dataRequestCases.organisationId,
            dataRequestCases.idempotencyKey
          ]
        })
        .returning();
      if (inserted !== undefined) {
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: input.actorUserId,
          eventType: 'DATA_REQUEST_VERIFIED',
          entityType: 'DATA_REQUEST',
          entityId: inserted.id,
          afterValue: {
            requestType: input.requestType,
            verifiedAt: input.verifiedAt.toISOString(),
            targetAt: input.targetAt.toISOString(),
            automaticDeletion: false
          },
          occurredAt: input.now
        });
        return { ok: true, value: inserted };
      }

      const [existing] = await transaction
        .select()
        .from(dataRequestCases)
        .where(
          and(
            eq(dataRequestCases.organisationId, input.organisationId),
            eq(dataRequestCases.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (
        existing === undefined ||
        existing.requestType !== input.requestType ||
        existing.verificationReference !== input.verificationReference ||
        existing.verifiedAt.getTime() !== input.verifiedAt.getTime() ||
        existing.targetAt.getTime() !== input.targetAt.getTime()
      ) {
        return { ok: false, code: 'CONFLICT' };
      }
      return { ok: true, value: existing };
    });
  }

  async reviewDataRequest(
    input: Parameters<RetentionOperationsRepository['reviewDataRequest']>[0]
  ): Promise<RetentionMutationResult> {
    return this.database.transaction(async (transaction) => {
      const [retentionCase] = await transaction
        .select({
          status: retentionCases.status,
          deletionEligibleAt: retentionCases.deletionEligibleAt,
          backupExpiryVerifiedAt: retentionCases.backupExpiryVerifiedAt
        })
        .from(retentionCases)
        .where(eq(retentionCases.organisationId, input.organisationId))
        .for('update')
        .limit(1);
      const [request] = await transaction
        .select()
        .from(dataRequestCases)
        .where(
          and(
            eq(dataRequestCases.id, input.requestId),
            eq(dataRequestCases.organisationId, input.organisationId)
          )
        )
        .for('update')
        .limit(1);
      if (request === undefined) return { ok: false, code: 'NOT_FOUND' };

      const decision = dataRequestReviewDecision({
        requestType: request.requestType,
        legalHold: retentionCase?.status === 'LEGAL_HOLD',
        deletionEligibleAt: retentionCase?.deletionEligibleAt ?? null,
        backupExpiryVerifiedAt:
          retentionCase?.backupExpiryVerifiedAt ?? null,
        now: input.now
      });

      if (
        request.status === decision.status &&
        request.blockReason === decision.blockReason
      ) {
        return { ok: true, value: request };
      }
      if (
        request.version !== input.expectedVersion ||
        request.status === 'COMPLETED'
      ) {
        return { ok: false, code: 'CONFLICT' };
      }

      const [updated] = await transaction
        .update(dataRequestCases)
        .set({
          status: decision.status,
          blockReason: decision.blockReason,
          version: request.version + 1,
          lastReviewedAt: input.now,
          lastReviewedByUserId: input.actorUserId,
          updatedAt: input.now
        })
        .where(
          and(
            eq(dataRequestCases.id, input.requestId),
            eq(dataRequestCases.organisationId, input.organisationId),
            eq(dataRequestCases.version, input.expectedVersion)
          )
        )
        .returning();
      if (updated === undefined) return { ok: false, code: 'CONFLICT' };

      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: input.actorUserId,
        eventType: 'DATA_REQUEST_OWNER_REVIEWED',
        entityType: 'DATA_REQUEST',
        entityId: input.requestId,
        beforeValue: {
          status: request.status,
          blockReason: request.blockReason,
          version: request.version
        },
        afterValue: {
          status: updated.status,
          blockReason: updated.blockReason,
          version: updated.version,
          reason: input.reason,
          automaticDeletion: false
        },
        occurredAt: input.now
      });
      return { ok: true, value: updated };
    });
  }

  async recordBackupExpiryVerification(
    input: Parameters<
      RetentionOperationsRepository['recordBackupExpiryVerification']
    >[0]
  ): Promise<RetentionMutationResult> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(retentionCases)
        .where(eq(retentionCases.organisationId, input.organisationId))
        .for('update')
        .limit(1);
      if (current === undefined) return { ok: false, code: 'NOT_FOUND' };
      if (
        current.backupExpiryVerifiedAt?.getTime() ===
          input.verifiedAt.getTime() &&
        current.backupExpiryEvidenceReference === input.evidenceReference
      ) {
        return { ok: true, value: current };
      }
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        return { ok: false, code: 'CONFLICT' };
      }

      const [updated] = await transaction
        .update(retentionCases)
        .set({
          backupExpiryVerifiedAt: input.verifiedAt,
          backupExpiryEvidenceReference: input.evidenceReference,
          updatedAt: input.now
        })
        .where(
          and(
            eq(retentionCases.organisationId, input.organisationId),
            eq(retentionCases.updatedAt, input.expectedUpdatedAt)
          )
        )
        .returning();
      if (updated === undefined) return { ok: false, code: 'CONFLICT' };

      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: input.actorUserId,
        eventType: 'BACKUP_AGEING_VERIFIED',
        entityType: 'RETENTION_CASE',
        entityId: input.organisationId,
        beforeValue: {
          backupExpiryVerifiedAt:
            current.backupExpiryVerifiedAt?.toISOString() ?? null,
          backupExpiryEvidenceReference:
            current.backupExpiryEvidenceReference
        },
        afterValue: {
          backupExpiryVerifiedAt: input.verifiedAt.toISOString(),
          backupExpiryEvidenceReference: input.evidenceReference,
          reason: input.reason,
          automaticDeletion: false
        },
        occurredAt: input.now
      });
      return { ok: true, value: updated };
    });
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const opaqueReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const createRetentionOperationsService = (dependencies: {
  verifyOwner(actorUserId: string): Promise<boolean>;
  repository: RetentionOperationsRepository;
  clock?: { now(): Date };
}) => {
  const now = () => dependencies.clock?.now() ?? new Date();
  const assertOwner = async (actorUserId: string) => {
    if (!(await dependencies.verifyOwner(actorUserId))) {
      throw new AuthorizationFailure();
    }
  };

  return {
    async listOperations(
      actorUserId: string,
      input: { organisationId?: string } = {}
    ): Promise<RetentionOperationsPage> {
      await assertOwner(actorUserId);
      const organisationId = input.organisationId?.trim();
      if (organisationId && !uuidPattern.test(organisationId)) {
        return { retentionCases: [], dataRequests: [] };
      }
      return dependencies.repository.listOperations(
        organisationId ? { organisationId } : {}
      );
    },

    async recordVerifiedRequest(
      actorUserId: string,
      input: {
        organisationId: string;
        requestType: DataRequestType;
        verificationReference: string;
        idempotencyKey: string;
        verifiedAt: Date;
      }
    ): Promise<RetentionMutationResult> {
      await assertOwner(actorUserId);
      const actionNow = now();
      const verificationReference = input.verificationReference.trim();
      const idempotencyKey = input.idempotencyKey.trim();
      if (
        !uuidPattern.test(input.organisationId) ||
        !['EXPORT', 'DELETION'].includes(input.requestType) ||
        !opaqueReferencePattern.test(verificationReference) ||
        !opaqueReferencePattern.test(idempotencyKey) ||
        !Number.isFinite(input.verifiedAt.getTime()) ||
        input.verifiedAt.getTime() > actionNow.getTime()
      ) {
        return { ok: false, code: 'VALIDATION' };
      }
      return dependencies.repository.recordVerifiedRequest({
        actorUserId,
        organisationId: input.organisationId,
        requestType: input.requestType,
        verificationReference,
        idempotencyKey,
        verifiedAt: input.verifiedAt,
        targetAt: new Date(
          input.verifiedAt.getTime() + 14 * 24 * 60 * 60 * 1000
        ),
        now: actionNow
      });
    },

    async reviewDataRequest(
      actorUserId: string,
      input: {
        organisationId: string;
        requestId: string;
        expectedVersion: number;
        reason: string;
      }
    ): Promise<RetentionMutationResult> {
      await assertOwner(actorUserId);
      const reason = input.reason.trim();
      if (
        !uuidPattern.test(input.organisationId) ||
        !uuidPattern.test(input.requestId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        reason.length === 0 ||
        reason.length > 500
      ) {
        return { ok: false, code: 'VALIDATION' };
      }
      return dependencies.repository.reviewDataRequest({
        actorUserId,
        organisationId: input.organisationId,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        reason,
        now: now()
      });
    },

    async recordBackupExpiryVerification(
      actorUserId: string,
      input: {
        organisationId: string;
        verifiedAt: Date;
        evidenceReference: string;
        expectedUpdatedAt: Date;
        reason: string;
      }
    ): Promise<RetentionMutationResult> {
      await assertOwner(actorUserId);
      const actionNow = now();
      const evidenceReference = input.evidenceReference.trim();
      const reason = input.reason.trim();
      if (
        !uuidPattern.test(input.organisationId) ||
        !Number.isFinite(input.verifiedAt.getTime()) ||
        input.verifiedAt.getTime() > actionNow.getTime() ||
        !opaqueReferencePattern.test(evidenceReference) ||
        !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
        reason.length === 0 ||
        reason.length > 500
      ) {
        return { ok: false, code: 'VALIDATION' };
      }
      return dependencies.repository.recordBackupExpiryVerification({
        actorUserId,
        organisationId: input.organisationId,
        verifiedAt: input.verifiedAt,
        evidenceReference,
        expectedUpdatedAt: input.expectedUpdatedAt,
        reason,
        now: actionNow
      });
    }
  };
};
