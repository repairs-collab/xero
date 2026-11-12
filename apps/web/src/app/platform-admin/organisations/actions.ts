import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import type { AppSession } from '@bc5000/auth';

import { requirePlatformOwner } from '../../../server/platform-authorization.js';
import {
  getPlatformAdminService,
  type createPlatformAdminService
} from '../../../server/platform-admin-service.js';

type PlatformAdminService = ReturnType<typeof createPlatformAdminService>;

export interface OrganisationAdminActionDependencies {
  getOwnerSession(): Promise<AppSession>;
  service: Pick<
    PlatformAdminService,
    'extendTrial' | 'endTrial' | 'suspendOrganisation' | 'reactivateOrganisation'
  >;
  revalidate(path: string): void;
}

export interface PlatformActionState {
  ok: boolean;
  code:
    | 'UPDATED'
    | 'CONFLICT'
    | 'INVALID_STATE'
    | 'VALIDATION'
    | 'BILLING_RISK_HOLD';
}

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const integer = (formData: FormData, name: string): number => {
  const value = Number(requiredText(formData, name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid`);
  }
  return value;
};

const date = (formData: FormData, name: string): Date => {
  const value = new Date(requiredText(formData, name));
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`);
  return value;
};

const state = (result: { ok: boolean; code?: PlatformActionState['code'] }): PlatformActionState =>
  result.ok
    ? { ok: true, code: 'UPDATED' }
    : { ok: false, code: result.code ?? 'INVALID_STATE' };

export const createOrganisationAdminActions = (
  dependencies: OrganisationAdminActionDependencies
) => {
  const finish = (organisationId: string) => {
    dependencies.revalidate('/platform-admin');
    dependencies.revalidate(`/platform-admin/organisations/${organisationId}`);
  };
  return {
    async extendTrialAction(formData: FormData): Promise<PlatformActionState> {
      const organisationId = requiredText(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.extendTrial(session.userId, {
        organisationId,
        newEnd: date(formData, 'newEnd'),
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        reason: requiredText(formData, 'reason')
      });
      if (result.ok) finish(organisationId);
      return state(result);
    },

    async endTrialAction(formData: FormData): Promise<PlatformActionState> {
      const organisationId = requiredText(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.endTrial(session.userId, {
        organisationId,
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        reason: requiredText(formData, 'reason')
      });
      if (result.ok) finish(organisationId);
      return state(result);
    },

    async suspendOrganisationAction(formData: FormData): Promise<PlatformActionState> {
      const organisationId = requiredText(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.suspendOrganisation(session.userId, {
        organisationId,
        reason: requiredText(formData, 'reason'),
        expectedVersion: integer(formData, 'expectedVersion')
      });
      if (result.ok) finish(organisationId);
      return state(result);
    },

    async reactivateOrganisationAction(formData: FormData): Promise<PlatformActionState> {
      const organisationId = requiredText(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.reactivateOrganisation(session.userId, {
        organisationId,
        reason: requiredText(formData, 'reason'),
        expectedVersion: integer(formData, 'expectedVersion')
      });
      if (result.ok) finish(organisationId);
      return state(result);
    }
  };
};

const actions = createOrganisationAdminActions({
  getOwnerSession: async () =>
    requirePlatformOwner(
      new Request('http://localhost/platform-admin', { headers: await headers() })
    ),
  service: getPlatformAdminService(),
  revalidate: revalidatePath
});

const redirectResult = (
  organisationId: string,
  result: PlatformActionState
): never =>
  redirect(
    `/platform-admin/organisations/${encodeURIComponent(organisationId)}?result=${result.code}`
  );

const run = async (
  formData: FormData,
  action: (data: FormData) => Promise<PlatformActionState>
): Promise<never> => {
  const organisationId = requiredText(formData, 'organisationId');
  let result: PlatformActionState;
  try {
    result = await action(formData);
  } catch {
    result = { ok: false, code: 'VALIDATION' };
  }
  return redirectResult(organisationId, result);
};

export async function extendTrialAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.extendTrialAction(data));
}
export async function endTrialAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.endTrialAction(data));
}
export async function suspendOrganisationAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.suspendOrganisationAction(data));
}
export async function reactivateOrganisationAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.reactivateOrganisationAction(data));
}
