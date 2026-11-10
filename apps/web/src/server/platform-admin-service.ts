import { AuthorizationFailure } from '@bc5000/auth';
import {
  PostgresPlatformAdminRepository,
  type PlatformAdminRepository,
  type PlatformAuditListInput,
  type PlatformNumberListInput,
  type PlatformOrganisationListInput,
  type PlatformOrganisationSort
} from '@bc5000/db/web';

import { getDatabaseClient } from './runtime.js';
import { isPlatformOwner } from './platform-authorization.js';

export interface PlatformAdminServiceDependencies {
  verifyOwner(userId: string): Promise<boolean>;
  repository: PlatformAdminRepository;
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

export const createPlatformAdminService = (
  dependencies: PlatformAdminServiceDependencies
) => {
  const now = () => dependencies.clock?.now() ?? new Date();
  const validReason = (reason: string) => {
    const value = reason.trim();
    return value.length > 0 && value.length <= 500;
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

  async listAuditEvents(actorUserId: string, input: PlatformAuditListInput = {}) {
    await assertOwner(dependencies, actorUserId);
    return dependencies.repository.listAuditEvents({
      ...input,
      page: positiveInteger(input.page, 1, Number.MAX_SAFE_INTEGER),
      pageSize: positiveInteger(input.pageSize, 25, 100)
    });
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
  }
  };
};

let service: ReturnType<typeof createPlatformAdminService> | undefined;

export const getPlatformAdminService = () => {
  service ??= createPlatformAdminService({
    verifyOwner: isPlatformOwner,
    repository: new PostgresPlatformAdminRepository(getDatabaseClient().db)
  });
  return service;
};
