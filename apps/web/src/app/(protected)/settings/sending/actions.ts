'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { authorise, AuthorizationFailure, type AppSession } from '@bc5000/auth';

import {
  getDatabaseClient,
  requireWebAcceptedSession
} from '../../../../server/runtime.js';
import { loadSettingsWorkspaceEdition } from '../settings-workspace.js';
import {
  createSendingSettings,
  liveActivationStatusForError,
  type ReconciliationMetrics
} from './sending-settings.js';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

const readAcknowledgement = (formData: FormData): string => {
  const value = formData.get('acknowledgement');
  return typeof value === 'string' ? value : '';
};

const nonnegativeInteger = (formData: FormData, name: string): number => {
  const value = Number(text(formData, name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
};

const booleanValue = (formData: FormData, name: string): boolean => {
  const value = text(formData, name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
};

const outstandingTotals = (formData: FormData): Record<string, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(formData, 'outstandingTotals'));
  } catch {
    throw new Error('outstandingTotals must be valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.entries(parsed).every(
      ([currency, amount]) =>
        /^[A-Z]{3}$/.test(currency) &&
        typeof amount === 'string' &&
        /^\d+(?:\.\d{1,4})?$/.test(amount)
    )
  ) {
    throw new Error('outstandingTotals is invalid');
  }
  return parsed as Record<string, string>;
};

const reconciliationMetrics = (formData: FormData): ReconciliationMetrics => ({
  activeContactCount: nonnegativeInteger(formData, 'activeContactCount'),
  outstandingInvoiceCount: nonnegativeInteger(
    formData,
    'outstandingInvoiceCount'
  ),
  outstandingTotals: outstandingTotals(formData),
  generatedApprovalCount: nonnegativeInteger(
    formData,
    'generatedApprovalCount'
  ),
  enabledSequenceCount: nonnegativeInteger(formData, 'enabledSequenceCount'),
  allEnabledSequencesReview: booleanValue(
    formData,
    'allEnabledSequencesReview'
  )
});

const rolloutErrorCodes = new Set([
  'FORBIDDEN',
  'OPERATIONAL_MAINTENANCE',
  'OPERATIONAL_STATE_CONFLICT',
  'RECONCILIATION_ACKNOWLEDGEMENT_MISMATCH',
  'RECONCILIATION_METRICS_CHANGED',
  'SYNC_SUPERSEDED',
  'CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT_MISMATCH',
  'CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT_MISMATCH',
  'CUSTOMER_ROLLOUT_NOT_READY',
  'ROLLOUT_STATE_CONFLICT',
  'INVALID_ALLOWLIST_RECIPIENT',
  'SUBSCRIPTION_REQUIRED',
  'TRIAL_EXPIRED',
  'PAYMENT_PAST_DUE',
  'ONBOARDING_INCOMPLETE',
  'REPLY_NUMBER_NOT_READY',
  'REASON_REQUIRED',
  'REASON_TOO_LONG'
]);

const rolloutActionStatusForError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'ROLLOUT_ACTION_FAILED';
  const code = error.message.split(':', 1)[0] ?? '';
  return rolloutErrorCodes.has(code) ? code : 'ROLLOUT_ACTION_FAILED';
};

async function context() {
  const session = await requireWebAcceptedSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  return {
    session,
    settings: createSendingSettings({
      database: getDatabaseClient().db,
      clock: { now: () => new Date() }
    })
  };
}

const finish = (status: string): never => {
  revalidatePath('/settings/sending');
  redirect(`/settings/sending?rollout=${encodeURIComponent(status)}`);
};

async function requireLegacySendingControls(session: AppSession, organisationId: string) {
  authorise(session, 'provider.configure', organisationId);
  const edition = await loadSettingsWorkspaceEdition(getDatabaseClient().db, organisationId);
  if (edition !== 'INTERNAL_LEGACY') throw new AuthorizationFailure();
}

export async function updateAllowlist(formData: FormData): Promise<void> {
  let status = 'allowlist-updated';
  try {
    const { session, settings } = await context();
    const organisationId = text(formData, 'organisationId');
    await requireLegacySendingControls(session, organisationId);
    const rawRecipients = formData.get('recipients');
    if (typeof rawRecipients !== 'string') {
      throw new Error('recipients is required');
    }
    await settings.updateAllowlist(session, {
      organisationId,
      recipients: rawRecipients.split(/[\n,]/)
    });
  } catch (error) {
    status = rolloutActionStatusForError(error);
  }
  finish(status);
}

export async function activateLive(formData: FormData): Promise<void> {
  let status = 'controlled-enabled';
  try {
    const { session, settings } = await context();
    const organisationId = text(formData, 'organisationId');
    await requireLegacySendingControls(session, organisationId);
    await settings.activateLive(session, {
      organisationId,
      acknowledgement: text(formData, 'acknowledgement'),
      expectedVersion: nonnegativeInteger(formData, 'expectedVersion')
    });
  } catch (error) {
    status = liveActivationStatusForError(error);
  }
  finish(status);
}

export async function acknowledgeReconciliation(
  formData: FormData
): Promise<void> {
  let status = 'reconciled';
  try {
    const { session, settings } = await context();
    await settings.acknowledgeReconciliation(session, {
      organisationId: text(formData, 'organisationId'),
      acknowledgement: readAcknowledgement(formData),
      expectedVersion: nonnegativeInteger(formData, 'expectedVersion'),
      expected: {
        syncId: text(formData, 'syncId'),
        syncCompletedAt: text(formData, 'syncCompletedAt'),
        metrics: reconciliationMetrics(formData)
      }
    });
  } catch (error) {
    status = rolloutActionStatusForError(error);
  }
  finish(status);
}

export async function activateCustomerRollout(
  formData: FormData
): Promise<void> {
  let status = 'customer-enabled';
  try {
    const { session, settings } = await context();
    await settings.activateCustomerRollout(session, {
      organisationId: text(formData, 'organisationId'),
      acknowledgement: readAcknowledgement(formData),
      expectedVersion: nonnegativeInteger(formData, 'expectedVersion')
    });
  } catch (error) {
    status = rolloutActionStatusForError(error);
  }
  finish(status);
}

export async function overrideCustomerRollout(
  formData: FormData
): Promise<void> {
  let status = 'customer-override-enabled';
  try {
    const { session, settings } = await context();
    await settings.overrideCustomerRollout(session, {
      organisationId: text(formData, 'organisationId'),
      acknowledgement: text(formData, 'acknowledgement'),
      reason: text(formData, 'reason'),
      expectedVersion: nonnegativeInteger(formData, 'expectedVersion')
    });
  } catch (error) {
    status = rolloutActionStatusForError(error);
  }
  finish(status);
}

export async function returnToControlledLive(
  formData: FormData
): Promise<void> {
  let status = 'controlled-restored';
  try {
    const { session, settings } = await context();
    const organisationId = text(formData, 'organisationId');
    await requireLegacySendingControls(session, organisationId);
    await settings.returnToControlledLive(session, {
      organisationId,
      reason: text(formData, 'reason'),
      expectedVersion: nonnegativeInteger(formData, 'expectedVersion')
    });
  } catch (error) {
    status = rolloutActionStatusForError(error);
  }
  finish(status);
}

export async function disableAllProviderSending(
  formData: FormData
): Promise<void> {
  let status = 'provider-sending-disabled';
  try {
    const { session, settings } = await context();
    await settings.disableAllProviderSending(session, {
      organisationId: text(formData, 'organisationId'),
      reason: text(formData, 'reason'),
      expectedVersion: nonnegativeInteger(formData, 'expectedVersion')
    });
  } catch (error) {
    status = rolloutActionStatusForError(error);
  }
  finish(status);
}

export async function disableLive(formData: FormData): Promise<void> {
  await disableAllProviderSending(formData);
}
