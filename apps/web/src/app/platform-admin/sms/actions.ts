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
    | 'verifySmsNumberForPool'
    | 'assignSmsNumber'
    | 'markSmsNumberReady'
    | 'quarantineSmsNumber'
    | 'releaseSmsNumber'
    | 'returnSmsNumberToPool'
    | 'updateSmsAllowance'
    | 'recordReplyNumberQuote'
    | 'completeReplyNumberDocumentation'
    | 'approveManualReplyNumberOrder'
    | 'recordManualReplyNumberOrder'
    | 'recordFulfilledReplyNumber'
    | 'failReplyNumberProvisioningRequest'
    | 'expireReplyNumberProvisioningRequest'
  >;
  revalidate(path: string): void;
}

export interface SmsAdminActionState {
  ok: boolean;
  code:
    | 'UPDATED'
    | 'CONFLICT'
    | 'INVALID_STATE'
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'NOT_OWNER'
    | 'NOT_ELIGIBLE'
    | 'BILLING_RISK_HOLD'
    | 'QUOTE_EXPIRED'
    | 'AMOUNT_MISMATCH'
    | 'NUMBER_CONFLICT';
}

export const parseAudMinor = (raw: string): number => {
  const value = raw.trim();
  const match = /^(0|[1-9]\d{0,7})(?:\.(\d{1,2}))?$/u.exec(value);
  if (!match) throw new Error('AUD amount is invalid');
  const whole = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const minor = whole * 100 + Number(fraction || '0');
  if (!Number.isSafeInteger(minor) || minor > 2_147_483_647) {
    throw new Error('AUD amount is invalid');
  }
  return minor;
};

export const parseSydneyLocalDate = (
  localValue: string,
  utcOffset: string
): Date => {
  const local = localValue.trim();
  const offset = utcOffset.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(local) ||
    !['+10:00', '+11:00'].includes(offset)
  ) {
    throw new Error('Sydney date or UTC offset is invalid');
  }
  const value = new Date(`${local}:00${offset}`);
  if (!Number.isFinite(value.getTime())) {
    throw new Error('Sydney date or UTC offset is invalid');
  }
  return value;
};

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

const checked = (formData: FormData, name: string): boolean =>
  formData.get(name) === 'on';

const documentationStatus = (
  formData: FormData
): 'NOT_REQUIRED' | 'REQUIRED' | 'COMPLETE' => {
  const value = text(formData, 'documentationStatus');
  if (!['NOT_REQUIRED', 'REQUIRED', 'COMPLETE'].includes(value)) {
    throw new Error('documentationStatus is invalid');
  }
  return value as 'NOT_REQUIRED' | 'REQUIRED' | 'COMPLETE';
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
    async recordReplyNumberQuoteAction(formData: FormData): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.recordReplyNumberQuote(
        session.userId,
        {
          organisationId,
          requestId: text(formData, 'requestId'),
          expectedVersion: positiveInteger(formData, 'expectedVersion'),
          setupFeeMinor: parseAudMinor(text(formData, 'setupFeeAud')),
          monthlyFeeMinor: parseAudMinor(text(formData, 'monthlyFeeAud')),
          quoteExpiresAt: parseSydneyLocalDate(
            text(formData, 'quoteExpiresLocal'),
            text(formData, 'quoteUtcOffset')
          ),
          documentationStatus: documentationStatus(formData),
          documentationEvidenceReference: optionalText(
            formData,
            'documentationEvidenceReference'
          ),
          reason: text(formData, 'reason')
        }
      );
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async completeReplyNumberDocumentationAction(
      formData: FormData
    ): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.completeReplyNumberDocumentation(
        session.userId,
        {
          organisationId,
          requestId: text(formData, 'requestId'),
          expectedVersion: positiveInteger(formData, 'expectedVersion'),
          documentationEvidenceReference: text(
            formData,
            'documentationEvidenceReference'
          ),
          reason: text(formData, 'reason')
        }
      );
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async approveManualReplyNumberOrderAction(
      formData: FormData
    ): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.approveManualReplyNumberOrder(
        session.userId,
        {
          organisationId,
          requestId: text(formData, 'requestId'),
          expectedVersion: positiveInteger(formData, 'expectedVersion'),
          confirmedSetupFeeMinor: parseAudMinor(
            text(formData, 'confirmedSetupFeeAud')
          ),
          confirmedMonthlyFeeMinor: parseAudMinor(
            text(formData, 'confirmedMonthlyFeeAud')
          ),
          approvalConfirmed: checked(formData, 'approvalConfirmed'),
          approvalPhrase: text(formData, 'approvalPhrase'),
          reason: text(formData, 'reason')
        }
      );
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async recordManualReplyNumberOrderAction(
      formData: FormData
    ): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.recordManualReplyNumberOrder(
        session.userId,
        {
          organisationId,
          requestId: text(formData, 'requestId'),
          expectedVersion: positiveInteger(formData, 'expectedVersion'),
          externalOrderReference: text(formData, 'externalOrderReference'),
          reason: text(formData, 'reason')
        }
      );
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async fulfilReplyNumberProvisioningRequestAction(
      formData: FormData
    ): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.recordFulfilledReplyNumber(
        session.userId,
        {
          organisationId,
          requestId: text(formData, 'requestId'),
          expectedVersion: positiveInteger(formData, 'expectedVersion'),
          e164Number: text(formData, 'e164Number'),
          providerNumberId: text(formData, 'providerNumberId'),
          reason: text(formData, 'reason')
        }
      );
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async failReplyNumberProvisioningRequestAction(
      formData: FormData
    ): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result =
        await dependencies.service.failReplyNumberProvisioningRequest(
          session.userId,
          {
            organisationId,
            requestId: text(formData, 'requestId'),
            expectedVersion: positiveInteger(formData, 'expectedVersion'),
            failureCode: text(formData, 'failureCode'),
            reason: text(formData, 'reason')
          }
        );
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

    async expireReplyNumberProvisioningRequestAction(
      formData: FormData
    ): Promise<SmsAdminActionState> {
      const organisationId = text(formData, 'organisationId');
      const session = await dependencies.getOwnerSession();
      const result =
        await dependencies.service.expireReplyNumberProvisioningRequest(
          session.userId,
          {
            organisationId,
            requestId: text(formData, 'requestId'),
            expectedVersion: positiveInteger(formData, 'expectedVersion'),
            reason: text(formData, 'reason')
          }
        );
      if (result.ok) finish(organisationId);
      return resultState(result);
    },

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

    async verifySmsNumberForPoolAction(formData: FormData): Promise<SmsAdminActionState> {
      const session = await dependencies.getOwnerSession();
      const result = await dependencies.service.verifySmsNumberForPool(session.userId, {
        numberId: text(formData, 'numberId'),
        expectedUpdatedAt: date(formData, 'expectedUpdatedAt'),
        providerNumberId: text(formData, 'providerNumberId'),
        reason: text(formData, 'reason'),
        verificationConfirmed: checked(formData, 'verificationConfirmed')
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
export async function recordReplyNumberQuoteAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.recordReplyNumberQuoteAction(data));
}
export async function completeReplyNumberDocumentationAction(formData: FormData) {
  'use server';
  return run(formData, (data) =>
    actions.completeReplyNumberDocumentationAction(data)
  );
}
export async function approveManualReplyNumberOrderAction(formData: FormData) {
  'use server';
  return run(formData, (data) =>
    actions.approveManualReplyNumberOrderAction(data)
  );
}
export async function recordManualReplyNumberOrderAction(formData: FormData) {
  'use server';
  return run(formData, (data) =>
    actions.recordManualReplyNumberOrderAction(data)
  );
}
export async function fulfilReplyNumberProvisioningRequestAction(formData: FormData) {
  'use server';
  return run(formData, (data) =>
    actions.fulfilReplyNumberProvisioningRequestAction(data)
  );
}
export async function failReplyNumberProvisioningRequestAction(formData: FormData) {
  'use server';
  return run(formData, (data) =>
    actions.failReplyNumberProvisioningRequestAction(data)
  );
}
export async function expireReplyNumberProvisioningRequestAction(formData: FormData) {
  'use server';
  return run(formData, (data) =>
    actions.expireReplyNumberProvisioningRequestAction(data)
  );
}
export async function verifySmsNumberForPoolAction(formData: FormData) {
  'use server';
  return run(formData, (data) => actions.verifySmsNumberForPoolAction(data));
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
