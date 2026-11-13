import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import type { AppSession } from '@bc5000/auth';

import { requirePlatformOwner } from '../../../../server/platform-authorization.js';
import { getSubscriptionService } from '../../../../server/runtime.js';
import type { createSubscriptionService } from '../../../../server/subscription-service.js';

type SubscriptionService = ReturnType<typeof createSubscriptionService>;

export type PlatformDirectDebitActionState =
  | { kind: 'IDLE' }
  | {
      kind: 'SETUP_LINK_CREATED';
      customerEmail: string;
      setupUrl: string;
    }
  | { kind: 'ACTIVATED' }
  | { kind: 'RECONCILED' }
  | { kind: 'VALIDATION' }
  | { kind: 'INVALID_STATE' }
  | { kind: 'FAILED' };

export interface PlatformDirectDebitActionDependencies {
  getOwnerSession(): Promise<AppSession>;
  getService(): Promise<
    Pick<
      SubscriptionService,
      | 'createDirectDebitSetup'
      | 'activateDirectDebit'
      | 'reconcileLegacyDirectDebit'
    >
  >;
  revalidate(path: string): void;
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('VALIDATION');
  }
  return value.trim();
};

const confirmedOrganisationId = (formData: FormData): string => {
  if (formData.get('confirmation') !== 'confirmed') {
    throw new Error('VALIDATION');
  }
  return text(formData, 'organisationId');
};

const reconciliationOutcomeFrom = (
  formData: FormData
): 'NO_LEGACY_DEFAULT' | 'LEGACY_DEFAULT_REMOVED' => {
  const value = formData.get('reconciliationOutcome');
  if (value !== 'NO_LEGACY_DEFAULT' && value !== 'LEGACY_DEFAULT_REMOVED') {
    throw new Error('VALIDATION');
  }
  return value;
};

const failure = (error: unknown): PlatformDirectDebitActionState => {
  const message = error instanceof Error ? error.message : '';
  if (message === 'VALIDATION') return { kind: 'VALIDATION' };
  if (
    message.includes('DIRECT_DEBIT_REQUEST_REQUIRED') ||
    message.includes('DIRECT_DEBIT_MANDATE_REQUIRED') ||
    message.includes('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED') ||
    message.includes('DIRECT_DEBIT_RECONCILIATION')
  ) {
    return { kind: 'INVALID_STATE' };
  }
  return { kind: 'FAILED' };
};

export const createPlatformDirectDebitActions = (
  dependencies: PlatformDirectDebitActionDependencies
) => ({
  async createSetupLinkAction(
    _previous: PlatformDirectDebitActionState,
    formData: FormData
  ): Promise<PlatformDirectDebitActionState> {
    try {
      const organisationId = confirmedOrganisationId(formData);
      const session = await dependencies.getOwnerSession();
      const service = await dependencies.getService();
      const setup = await service.createDirectDebitSetup(
        session,
        organisationId
      );
      dependencies.revalidate(
        `/platform-admin/organisations/${encodeURIComponent(organisationId)}`
      );
      return {
        kind: 'SETUP_LINK_CREATED',
        customerEmail: setup.customerEmail,
        setupUrl: setup.url
      };
    } catch (error) {
      return failure(error);
    }
  },

  async activateDirectDebitAction(
    _previous: PlatformDirectDebitActionState,
    formData: FormData
  ): Promise<PlatformDirectDebitActionState> {
    try {
      const organisationId = confirmedOrganisationId(formData);
      const session = await dependencies.getOwnerSession();
      const service = await dependencies.getService();
      await service.activateDirectDebit(session, organisationId);
      dependencies.revalidate(
        `/platform-admin/organisations/${encodeURIComponent(organisationId)}`
      );
      return { kind: 'ACTIVATED' };
    } catch (error) {
      return failure(error);
    }
  },

  async reconcileLegacyAction(
    _previous: PlatformDirectDebitActionState,
    formData: FormData
  ): Promise<PlatformDirectDebitActionState> {
    try {
      const organisationId = confirmedOrganisationId(formData);
      const directDebitRequestId = text(formData, 'directDebitRequestId');
      const outcome = reconciliationOutcomeFrom(formData);
      const providerReference = text(
        formData,
        'providerReconciliationReference'
      );
      const session = await dependencies.getOwnerSession();
      const service = await dependencies.getService();
      await service.reconcileLegacyDirectDebit(
        session,
        organisationId,
        directDebitRequestId,
        outcome,
        providerReference
      );
      dependencies.revalidate(
        `/platform-admin/organisations/${encodeURIComponent(organisationId)}`
      );
      return { kind: 'RECONCILED' };
    } catch (error) {
      return failure(error);
    }
  }
});

const actions = createPlatformDirectDebitActions({
  getOwnerSession: async () =>
    requirePlatformOwner(
      new Request('http://localhost/platform-admin', {
        headers: await headers()
      })
    ),
  getService: getSubscriptionService,
  revalidate: revalidatePath
});

export async function createDirectDebitSetupLinkAction(
  previous: PlatformDirectDebitActionState,
  formData: FormData
): Promise<PlatformDirectDebitActionState> {
  'use server';
  return actions.createSetupLinkAction(previous, formData);
}

export async function activateDirectDebitAction(
  previous: PlatformDirectDebitActionState,
  formData: FormData
): Promise<PlatformDirectDebitActionState> {
  'use server';
  return actions.activateDirectDebitAction(previous, formData);
}

export async function reconcileLegacyDirectDebitAction(
  previous: PlatformDirectDebitActionState,
  formData: FormData
): Promise<PlatformDirectDebitActionState> {
  'use server';
  return actions.reconcileLegacyAction(previous, formData);
}
