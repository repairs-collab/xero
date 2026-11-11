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

export interface SmsAdminActionDependencies {
  getOwnerSession(): Promise<AppSession>;
  service: Pick<
    PlatformAdminService,
    | 'registerSmsNumber'
    | 'assignSmsNumber'
    | 'markSmsNumberReady'
    | 'quarantineSmsNumber'
    | 'releaseSmsNumber'
    | 'returnSmsNumberToPool'
    | 'updateSmsAllowance'
  >;
  revalidate(path: string): void;
}

export interface SmsAdminActionState {
  ok: boolean;
  code: 'UPDATED' | 'CONFLICT' | 'INVALID_STATE' | 'VALIDATION';
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const optionalText = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const date = (formData: FormData, name: string): Date => {
  const value = new Date(text(formData, name));
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`);
  return value;
};

const optionalDate = (formData: FormData, name: string): Date | null => {
  const value = optionalText(formData, name);
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed;
};

const positiveInteger = (formData: FormData, name: string): number => {
  const value = Number(text(formData, name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} is invalid`);
  }
  return value;
};

const resultState = (result: {
  ok: boolean;
  code?: SmsAdminActionState['code'];
}): SmsAdminActionState =>
  result.ok
    ? { ok: true, code: 'UPDATED' }
    : { ok: false, code: result.code ?? 'INVALID_STATE' };

export const createSmsAdminActions = (
  dependencies: SmsAdminActionDependencies
) => {
  const finish = (organisationId?: string) => {
    dependencies.revalidate('/platform-admin/sms');
    dependencies.revalidate('/platform-admin');
    if (organisationId) {
      dependencies.revalidate(`/platform-admin/organisations/${organisationId}`);
    }
  };
  return {
    async registerSmsNumberAction(formData: FormData): Promise<SmsAdminActionState> {
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.registerSmsNumber(session.userId, {
        e164Number: text(formData, 'e164Number'),
        providerNumberId: optionalText(formData, 'providerNumberId'),
        reason: text(formData, 'reason')
      });
      if (result.ok) finish();
      return resultState(result);
    },

    async assignSmsNumberAction(formData: FormData): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.assignSmsNumber(session.userId, {
        numberId: text(formData, 'numberId'),
        organisationId,
        expectedStatus: text(formData, 'expectedStatus') as 'AVAILABLE' | 'RELEASED',
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        reason: text(formData, 'reason')
      });
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async markSmsNumberReadyAction(formData: FormData): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.markSmsNumberReady(session.userId, {
        numberId: text(formData, 'numberId'),
        organisationId,
        expectedStatus: 'RESERVED',
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        providerNumberId: text(formData, 'providerNumberId'),
        reason: text(formData, 'reason')
      });
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async quarantineSmsNumberAction(formData: FormData): Promise<SmsAdminActionState> {
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.quarantineSmsNumber(session.userId, {
        numberId: text(formData, 'numberId'),
        expectedStatus: text(formData, 'expectedStatus') as 'RESERVED' | 'READY',
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        quarantineUntil: new Date(text(formData, 'quarantineUntil')),
        reason: text(formData, 'reason')
      });
      if (result.ok) finish(result.value.organisationId ?? undefined);
      return resultState(result);
    },

    async releaseSmsNumberAction(formData: FormData): Promise<SmsAdminActionState> {
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.releaseSmsNumber(session.userId, {
        numberId: text(formData, 'numberId'),
        expectedStatus: text(formData, 'expectedStatus') as 'RESERVED' | 'READY',
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        reason: text(formData, 'reason')
      });
      if (result.ok) finish(result.value.organisationId ?? undefined);
      return resultState(result);
    },

    async returnSmsNumberToPoolAction(formData: FormData): Promise<SmsAdminActionState> {
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.returnSmsNumberToPool(session.userId, {
        numberId: text(formData, 'numberId'),
        expectedStatus: 'QUARANTINED',
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        reason: text(formData, 'reason')
      });
      if (result.ok) finish();
      return resultState(result);
    },

    async updateSmsAllowanceAction(formData: FormData): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.updateSmsAllowance(session.userId, {
        organisationId,
        includedParts: positiveInteger(formData, 'includedParts'),
        warningPercent: positiveInteger(formData, 'warningPercent'),
        expectedUpdatedAt: optionalDate(formData, 'expectedUpdatedAt'),
        reason: text(formData, 'reason')
      });
      if (result.ok) finish(organisationId);
      return resultState(result);
    }
  };
};

const actions = createSmsAdminActions({
  getOwnerSession: async () =>
    requirePlatformOwner(
      new Request('http://localhost/platform-admin/sms', {
        headers: await headers()
      })
    ),
  service: getPlatformAdminService(),
  revalidate: revalidatePath
});

const run = async (
  formData: FormData,
  action: (data: FormData) => Promise<SmsAdminActionState>,
  destination: 'sms' | 'organisation' = 'sms'
): Promise<never> => {
  let result: SmsAdminActionState;
  try {
    result = await action(formData);
  } catch {
    result = { ok: false, code: 'VALIDATION' };
  }
  const organisationId = optionalText(formData, 'organisationId');
  const path =
    destination === 'organisation' && organisationId
      ? `/platform-admin/organisations/${encodeURIComponent(organisationId)}`
      : '/platform-admin/sms';
  redirect(`${path}?result=${result.code}`);
};

export async function registerSmsNumberAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.registerSmsNumberAction(data));
}
export async function assignSmsNumberAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.assignSmsNumberAction(data));
}
export async function markSmsNumberReadyAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.markSmsNumberReadyAction(data));
}
export async function quarantineSmsNumberAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.quarantineSmsNumberAction(data));
}
export async function releaseSmsNumberAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.releaseSmsNumberAction(data));
}
export async function returnSmsNumberToPoolAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.returnSmsNumberToPoolAction(data));
}
export async function updateSmsAllowanceAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.updateSmsAllowanceAction(data), 'organisation');
}
