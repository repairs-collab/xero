import { AuthorizationFailure } from '@bc5000/auth';
import { PostgresReplyNumberProvisioningRepository } from '@bc5000/db';
import {
  PostgresPlatformAdminRepository,
  type PlatformAdminRepository,
  type PlatformAuditListInput,
  type PlatformBillingOperationsListInput,
  type PlatformNumberListInput,
  type PlatformReplyNumberProvisioningListInput,
  type PlatformOrganisationListInput,
  type PlatformOrganisationSort
} from '@bc5000/db/web';

import { getDatabaseClient } from './runtime.js';
import { isPlatformOwner } from './platform-authorization.js';

export interface PlatformAdminServiceDependencies {
  verifyOwner(userId: string): Promise<boolean>;
  repository: PlatformAdminRepository;
  provisioningRepository?: Pick<
    PostgresReplyNumberProvisioningRepository,
    | 'recordQuote'
    | 'recordDocumentationComplete'
    | 'approveManualOrder'
    | 'recordManualOrderReference'
    | 'recordFulfilledNumber'
    | 'failRequest'
    | 'expireRequest'
  >;
  clock?: { now(): Date };
}

const positiveInteger = (value: unknown, fallback: number, maximum: number) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;

const organisationInput = (
  input: Record<string, unknown>
): PlatformOrganisationListInput => ({
  search: typeof input.search === 'string' ? input.search.trim().slice(0, 100) : '',
  page: positiveInteger(input.page, 1, Number.MAX_SAFE_INTEGER),
  pageSize: positiveInteger(input.pageSize, 25, 100),
  sort: ['name', 'trialEnd', 'status', 'usage'].includes(String(input.sort))
    ? (input.sort as PlatformOrganisationSort)
    : 'name',
  direction: input.direction === 'desc' ? 'desc' : 'asc'
});

const assertOwner = async (
  dependencies: PlatformAdminServiceDependencies,
  actorUserId: string
) => {
  if (!(await dependencies.verifyOwner(actorUserId))) {
    throw new AuthorizationFailure();
  }
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const emptyBillingOperationsPage = () => ({
  cases: { items: [], nextCursor: null },
  heldEmails: { items: [], nextCursor: null }
});

const replyNumberProvisioningStatuses = [
  'AWAITING_QUOTE',
  'AWAITING_OWNER_APPROVAL',
  'APPROVED_FOR_MANUAL_ORDER',
  'MANUAL_ORDER_RECORDED',
  'FULFILLED',
  'FAILED',
  'EXPIRED'
] as const;

const replyNumberDocumentationStatuses = [
  'UNKNOWN',
  'NOT_REQUIRED',
  'REQUIRED',
  'COMPLETE'
] as const;

const emptyReplyNumberProvisioningPage = () => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 25
});

export const createPlatformAdminService = (
  dependencies: PlatformAdminServiceDependencies
) => {
  const now = () => dependencies.clock?.now() ?? new Date();
  const validReason = (reason: string) => {
    const value = reason.trim();
    return value.length > 0 && value.length <= 500;
  };
  const validReference = (value: string, maximum: number) => {
    const cleaned = value.trim();
    return (
      cleaned.length > 0 &&
      cleaned.length <= maximum &&
      !/[\r\n\0]/u.test(cleaned)
    );
  };
  const validOpaqueReference = (value: string) => {
    const cleaned = value.trim();
    return (
      cleaned.length > 0 &&
      cleaned.length <= 128 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(cleaned)
    );
  };
  const validRequestTarget = (input: {
    organisationId: string;
    requestId: string;
    expectedVersion: number;
  }) =>
    uuidPattern.test(input.organisationId) &&
    uuidPattern.test(input.requestId) &&
    Number.isSafeInteger(input.expectedVersion) &&
    input.expectedVersion >= 1;
  const provisioningRepository = () => {
    if (!dependencies.provisioningRepository) {
      throw new Error('Reply-number provisioning repository is not configured');
    }
    return dependencies.provisioningRepository;
  };
  return {
  async listOrganisations(
    actorUserId: string,
    input: Record<string, unknown> = {}
  ) {
    await assertOwner(dependencies, actorUserId);
    return dependencies.repository.listOrganisations(organisationInput(input));
  },

  async getOrganisationDetail(actorUserId: string, organisationId: string) {
    await assertOwner(dependencies, actorUserId);
    return dependencies.repository.getOrganisationDetail(organisationId);
  },

  async listNumbers(actorUserId: string, input: PlatformNumberListInput = {}) {
    await assertOwner(dependencies, actorUserId);
    const { search, ...filters } = input;
    const normalizedSearch = search?.trim().slice(0, 100);
    return dependencies.repository.listSmsNumbers({
      ...filters,
      ...(normalizedSearch ? { search: normalizedSearch } : {}),
      page: positiveInteger(input.page, 1, Number.MAX_SAFE_INTEGER),
      pageSize: positiveInteger(input.pageSize, 25, 100)
    });
  },

  async listReplyNumberProvisioningRequests(
    actorUserId: string,
    input: Record<string, unknown> = {}
  ) {
    await assertOwner(dependencies, actorUserId);
    const organisationId =
      typeof input.organisationId === 'string'
        ? input.organisationId.trim()
        : '';
    const status = typeof input.status === 'string' ? input.status.trim() : '';
    const documentationStatus =
      typeof input.documentationStatus === 'string'
        ? input.documentationStatus.trim()
        : '';
    if (
      (organisationId && !uuidPattern.test(organisationId)) ||
      (status &&
        !replyNumberProvisioningStatuses.includes(
          status as (typeof replyNumberProvisioningStatuses)[number]
        )) ||
      (documentationStatus &&
        !replyNumberDocumentationStatuses.includes(
          documentationStatus as (typeof replyNumberDocumentationStatuses)[number]
        ))
    ) {
      return emptyReplyNumberProvisioningPage();
    }
    const search =
      typeof input.search === 'string' ? input.search.trim().slice(0, 100) : '';
    const normalized: PlatformReplyNumberProvisioningListInput = {
      ...(organisationId ? { organisationId } : {}),
      ...(search ? { search } : {}),
      ...(status
        ? {
            status:
              status as NonNullable<
                PlatformReplyNumberProvisioningListInput['status']
              >
          }
        : {}),
      ...(documentationStatus
        ? {
            documentationStatus:
              documentationStatus as NonNullable<
                PlatformReplyNumberProvisioningListInput['documentationStatus']
              >
          }
        : {}),
      page: positiveInteger(input.page, 1, Number.MAX_SAFE_INTEGER),
      pageSize: positiveInteger(input.pageSize, 25, 100)
    };
    return dependencies.repository.listReplyNumberProvisioningRequests(
      normalized
    );
  },

  async listAuditEvents(actorUserId: string, input: PlatformAuditListInput = {}) {
    await assertOwner(dependencies, actorUserId);
    return dependencies.repository.listAuditEvents({
      ...input,
      page: positiveInteger(input.page, 1, Number.MAX_SAFE_INTEGER),
      pageSize: positiveInteger(input.pageSize, 25, 100)
    });
  },

  async listBillingOperations(
    actorUserId: string,
    input: Record<string, unknown> = {}
  ) {
    await assertOwner(dependencies, actorUserId);
    const organisationId =
      typeof input.organisationId === 'string'
        ? input.organisationId.trim()
        : '';
    if (organisationId && !uuidPattern.test(organisationId)) {
      return emptyBillingOperationsPage();
    }
    const caseKind =
      typeof input.caseKind === 'string' ? input.caseKind.trim() : '';
    const caseStatus =
      typeof input.caseStatus === 'string' ? input.caseStatus.trim() : '';
    if (
      (caseKind && !['PAYMENT_FAILURE', 'REFUND', 'DISPUTE'].includes(caseKind)) ||
      (caseStatus &&
        !['OPEN', 'RESOLVED', 'REVIEW_REQUIRED'].includes(caseStatus))
    ) {
      return emptyBillingOperationsPage();
    }
    const casesCursor =
      typeof input.casesCursor === 'string'
        ? input.casesCursor.trim().slice(0, 1_000)
        : '';
    const heldEmailsCursor =
      typeof input.heldEmailsCursor === 'string'
        ? input.heldEmailsCursor.trim().slice(0, 1_000)
        : '';
    const normalized: PlatformBillingOperationsListInput = {
      ...(organisationId ? { organisationId } : {}),
      ...(caseKind
        ? {
            caseKind:
              caseKind as NonNullable<
                PlatformBillingOperationsListInput['caseKind']
              >
          }
        : {}),
      ...(caseStatus
        ? {
            caseStatus:
              caseStatus as NonNullable<
                PlatformBillingOperationsListInput['caseStatus']
              >
          }
        : {}),
      ...(casesCursor ? { casesCursor } : {}),
      ...(heldEmailsCursor ? { heldEmailsCursor } : {}),
      limit: positiveInteger(input.limit, 25, 100)
    };
    return dependencies.repository.listBillingOperations(normalized);
  },

  async extendTrial(
    actorUserId: string,
    input: {
      organisationId: string;
      newEnd: Date;
      expectedUpdatedAt: Date;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    const actionNow = now();
    if (
      !validReason(input.reason) ||
      !Number.isFinite(input.newEnd.getTime()) ||
      input.newEnd.getTime() <= actionNow.getTime() ||
      input.newEnd.getTime() > actionNow.getTime() + 90 * 24 * 60 * 60 * 1000
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.extendTrial({
      ...input,
      reason: input.reason.trim(),
      actorUserId,
      now: actionNow
    });
  },

  async endTrial(
    actorUserId: string,
    input: { organisationId: string; expectedUpdatedAt: Date; reason: string }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason)) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.endTrial({
      ...input,
      reason: input.reason.trim(),
      actorUserId,
      now: now()
    });
  },

  async suspendOrganisation(
    actorUserId: string,
    input: { organisationId: string; expectedVersion: number; reason: string }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason) || !Number.isSafeInteger(input.expectedVersion)) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.suspendOrganisation({
      ...input,
      reason: input.reason.trim(),
      actorUserId,
      now: now()
    });
  },

  async reactivateOrganisation(
    actorUserId: string,
    input: { organisationId: string; expectedVersion: number; reason: string }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason) || !Number.isSafeInteger(input.expectedVersion)) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.reactivateOrganisation({
      ...input,
      reason: input.reason.trim(),
      actorUserId,
      now: now()
    });
  },

  async registerSmsNumber(
    actorUserId: string,
    input: { e164Number: string; providerNumberId: string | null; reason: string }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason) || !/^\+61\d{9}$/.test(input.e164Number)) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.registerSmsNumber({
      actorUserId,
      e164Number: input.e164Number,
      provider: 'SINCH',
      providerNumberId: input.providerNumberId?.trim() || null,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async verifySmsNumberForPool(
    actorUserId: string,
    input: {
      numberId: string;
      expectedUpdatedAt: Date;
      providerNumberId: string;
      reason: string;
      verificationConfirmed: boolean;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    const providerNumberId = input.providerNumberId.trim();
    if (
      !input.verificationConfirmed ||
      !validReason(input.reason) ||
      providerNumberId.length === 0 ||
      providerNumberId.length > 128
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.verifySmsNumberForPool({
      actorUserId,
      numberId: input.numberId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      providerNumberId,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async assignSmsNumber(
    actorUserId: string,
    input: {
      numberId: string;
      organisationId: string;
      expectedStatus: 'AVAILABLE' | 'RELEASED';
      expectedUpdatedAt: Date;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason)) return { ok: false, code: 'VALIDATION' } as const;
    return dependencies.repository.assignSmsNumber({
      ...input,
      actorUserId,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async markSmsNumberReady(
    actorUserId: string,
    input: {
      numberId: string;
      organisationId: string;
      expectedStatus: 'RESERVED';
      expectedUpdatedAt: Date;
      providerNumberId: string;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason) || input.providerNumberId.trim() === '') {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.markSmsNumberReady({
      ...input,
      actorUserId,
      providerNumberId: input.providerNumberId.trim(),
      reason: input.reason.trim(),
      now: now()
    });
  },

  async quarantineSmsNumber(
    actorUserId: string,
    input: {
      numberId: string;
      expectedStatus: 'RESERVED' | 'READY';
      expectedUpdatedAt: Date;
      quarantineUntil: Date;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    const actionNow = now();
    if (
      !validReason(input.reason) ||
      !Number.isFinite(input.quarantineUntil.getTime()) ||
      input.quarantineUntil.getTime() <
        actionNow.getTime() + 30 * 24 * 60 * 60 * 1000
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.quarantineSmsNumber({
      ...input,
      actorUserId,
      reason: input.reason.trim(),
      now: actionNow
    });
  },

  async releaseSmsNumber(
    actorUserId: string,
    input: {
      numberId: string;
      expectedStatus: 'RESERVED' | 'READY';
      expectedUpdatedAt: Date;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason)) return { ok: false, code: 'VALIDATION' } as const;
    return dependencies.repository.releaseSmsNumber({
      ...input,
      actorUserId,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async returnSmsNumberToPool(
    actorUserId: string,
    input: {
      numberId: string;
      expectedStatus: 'QUARANTINED';
      expectedUpdatedAt: Date;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validReason(input.reason)) return { ok: false, code: 'VALIDATION' } as const;
    return dependencies.repository.returnSmsNumberToPool({
      ...input,
      actorUserId,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async updateSmsAllowance(
    actorUserId: string,
    input: {
      organisationId: string;
      includedParts: number;
      warningPercent: number;
      expectedUpdatedAt: Date | null;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (
      !validReason(input.reason) ||
      !Number.isSafeInteger(input.includedParts) ||
      input.includedParts < 1 ||
      input.includedParts > 1_000_000 ||
      !Number.isSafeInteger(input.warningPercent) ||
      input.warningPercent < 1 ||
      input.warningPercent > 100
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return dependencies.repository.updateSmsAllowance({
      ...input,
      actorUserId,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async recordReplyNumberQuote(
    actorUserId: string,
    input: {
      organisationId: string;
      requestId: string;
      expectedVersion: number;
      setupFeeMinor: number;
      monthlyFeeMinor: number;
      quoteExpiresAt: Date;
      documentationStatus: 'NOT_REQUIRED' | 'REQUIRED' | 'COMPLETE';
      documentationEvidenceReference: string | null;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    const actionNow = now();
    const evidenceReference =
      input.documentationEvidenceReference?.trim() || null;
    if (
      !validRequestTarget(input) ||
      !validReason(input.reason) ||
      !Number.isSafeInteger(input.setupFeeMinor) ||
      input.setupFeeMinor < 0 ||
      input.setupFeeMinor > 2_147_483_647 ||
      !Number.isSafeInteger(input.monthlyFeeMinor) ||
      input.monthlyFeeMinor < 0 ||
      input.monthlyFeeMinor > 2_147_483_647 ||
      !Number.isFinite(input.quoteExpiresAt.getTime()) ||
      input.quoteExpiresAt.getTime() <= actionNow.getTime() ||
      !['NOT_REQUIRED', 'REQUIRED', 'COMPLETE'].includes(
        input.documentationStatus
      ) ||
      (evidenceReference !== null && !validOpaqueReference(evidenceReference)) ||
      (input.documentationStatus === 'COMPLETE' && evidenceReference === null)
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return provisioningRepository().recordQuote({
      actorUserId,
      organisationId: input.organisationId,
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      setupFeeMinor: input.setupFeeMinor,
      monthlyFeeMinor: input.monthlyFeeMinor,
      currency: 'aud',
      quoteExpiresAt: input.quoteExpiresAt,
      documentationStatus: input.documentationStatus,
      documentationEvidenceReference: evidenceReference,
      reason: input.reason.trim(),
      now: actionNow
    });
  },

  async completeReplyNumberDocumentation(
    actorUserId: string,
    input: {
      organisationId: string;
      requestId: string;
      expectedVersion: number;
      documentationEvidenceReference: string;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (
      !validRequestTarget(input) ||
      !validReason(input.reason) ||
      !validOpaqueReference(input.documentationEvidenceReference)
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return provisioningRepository().recordDocumentationComplete({
      ...input,
      actorUserId,
      documentationEvidenceReference:
        input.documentationEvidenceReference.trim(),
      reason: input.reason.trim(),
      now: now()
    });
  },

  async approveManualReplyNumberOrder(
    actorUserId: string,
    input: {
      organisationId: string;
      requestId: string;
      expectedVersion: number;
      confirmedSetupFeeMinor: number;
      confirmedMonthlyFeeMinor: number;
      approvalConfirmed: boolean;
      approvalPhrase: string;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (
      !validRequestTarget(input) ||
      !validReason(input.reason) ||
      !input.approvalConfirmed ||
      input.approvalPhrase.trim() !== 'APPROVE EXACT QUOTE' ||
      !Number.isSafeInteger(input.confirmedSetupFeeMinor) ||
      input.confirmedSetupFeeMinor < 0 ||
      input.confirmedSetupFeeMinor > 2_147_483_647 ||
      !Number.isSafeInteger(input.confirmedMonthlyFeeMinor) ||
      input.confirmedMonthlyFeeMinor < 0 ||
      input.confirmedMonthlyFeeMinor > 2_147_483_647
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return provisioningRepository().approveManualOrder({
      actorUserId,
      organisationId: input.organisationId,
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      confirmedSetupFeeMinor: input.confirmedSetupFeeMinor,
      confirmedMonthlyFeeMinor: input.confirmedMonthlyFeeMinor,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async recordManualReplyNumberOrder(
    actorUserId: string,
    input: {
      organisationId: string;
      requestId: string;
      expectedVersion: number;
      externalOrderReference: string;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (
      !validRequestTarget(input) ||
      !validReason(input.reason) ||
      !validOpaqueReference(input.externalOrderReference)
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return provisioningRepository().recordManualOrderReference({
      ...input,
      actorUserId,
      externalOrderReference: input.externalOrderReference.trim(),
      reason: input.reason.trim(),
      now: now()
    });
  },

  async recordFulfilledReplyNumber(
    actorUserId: string,
    input: {
      organisationId: string;
      requestId: string;
      expectedVersion: number;
      e164Number: string;
      providerNumberId: string;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (
      !validRequestTarget(input) ||
      !validReason(input.reason) ||
      !/^\+61\d{9}$/u.test(input.e164Number) ||
      !validReference(input.providerNumberId, 128)
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return provisioningRepository().recordFulfilledNumber({
      ...input,
      actorUserId,
      providerNumberId: input.providerNumberId.trim(),
      reason: input.reason.trim(),
      now: now()
    });
  },

  async failReplyNumberProvisioningRequest(
    actorUserId: string,
    input: {
      organisationId: string;
      requestId: string;
      expectedVersion: number;
      failureCode: string;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    const failureCode = input.failureCode.trim();
    if (
      !validRequestTarget(input) ||
      !validReason(input.reason) ||
      !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(failureCode)
    ) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return provisioningRepository().failRequest({
      ...input,
      actorUserId,
      failureCode,
      reason: input.reason.trim(),
      now: now()
    });
  },

  async expireReplyNumberProvisioningRequest(
    actorUserId: string,
    input: {
      organisationId: string;
      requestId: string;
      expectedVersion: number;
      reason: string;
    }
  ) {
    await assertOwner(dependencies, actorUserId);
    if (!validRequestTarget(input) || !validReason(input.reason)) {
      return { ok: false, code: 'VALIDATION' } as const;
    }
    return provisioningRepository().expireRequest({
      ...input,
      actorUserId,
      reason: input.reason.trim(),
      now: now()
    });
  }
  };
};

let service: ReturnType<typeof createPlatformAdminService> | undefined;

export const getPlatformAdminService = () => {
  service ??= createPlatformAdminService({
    verifyOwner: isPlatformOwner,
    repository: new PostgresPlatformAdminRepository(getDatabaseClient().db),
    provisioningRepository: new PostgresReplyNumberProvisioningRepository(
      getDatabaseClient().db
    )
  });
  return service;
};
