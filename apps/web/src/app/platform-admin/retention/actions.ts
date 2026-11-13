import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import type { AppSession } from '@bc5000/auth';
import type { DataRequestType } from '@bc5000/db/web';

import { requirePlatformOwner } from '../../../server/platform-authorization.js';
import { getRetentionOperationsService } from '../../../server/retention-operations-runtime.js';
import type { createRetentionOperationsService } from '../../../server/retention-operations.js';

type RetentionOperationsService = ReturnType<
  typeof createRetentionOperationsService
>;

export interface RetentionActionDependencies {
  getOwnerSession(): Promise<AppSession>;
  service: Pick<
    RetentionOperationsService,
    | 'recordVerifiedRequest'
    | 'reviewDataRequest'
    | 'recordBackupExpiryVerification'
    | 'completeExportRequest'
  >;
  revalidate(path: string): void;
  redirect(path: string): void;
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const utcDateTime = (value: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) {
    throw new Error('verifiedAt is invalid');
  }
  const parsed = new Date(`${value}:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('verifiedAt is invalid');
  }
  return parsed;
};

const date = (value: string, name: string): Date => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed;
};

const resultCode = (result: { ok: boolean; code?: string }): string =>
  result.ok ? 'UPDATED' : (result.code ?? 'CONFLICT');

export const createRetentionActionHandlers = (
  dependencies: RetentionActionDependencies
) => ({
  async recordVerifiedRequest(formData: FormData): Promise<void> {
    const session = await dependencies.getOwnerSession();
    const result = await dependencies.service.recordVerifiedRequest(
      session.userId,
      {
        organisationId: text(formData, 'organisationId'),
        requestType: text(formData, 'requestType') as DataRequestType,
        verificationReference: text(formData, 'verificationReference'),
        idempotencyKey: text(formData, 'idempotencyKey'),
        verifiedAt: utcDateTime(text(formData, 'verifiedAt'))
      }
    );
    dependencies.revalidate('/platform-admin/retention');
    dependencies.redirect(
      `/platform-admin/retention?result=${encodeURIComponent(resultCode(result))}`
    );
  },

  async reviewRequest(formData: FormData): Promise<void> {
    const session = await dependencies.getOwnerSession();
    const result = await dependencies.service.reviewDataRequest(
      session.userId,
      {
        organisationId: text(formData, 'organisationId'),
        requestId: text(formData, 'requestId'),
        expectedVersion: Number(text(formData, 'expectedVersion')),
        operationId: text(formData, 'operationId'),
        reason: text(formData, 'reason')
      }
    );
    dependencies.revalidate('/platform-admin/retention');
    dependencies.redirect(
      `/platform-admin/retention?result=${encodeURIComponent(resultCode(result))}`
    );
  },

  async recordBackupExpiryVerification(formData: FormData): Promise<void> {
    const session = await dependencies.getOwnerSession();
    const result = await dependencies.service.recordBackupExpiryVerification(
      session.userId,
      {
        organisationId: text(formData, 'organisationId'),
        closureEpisodeId: text(formData, 'closureEpisodeId'),
        verifiedAt: utcDateTime(text(formData, 'verifiedAt')),
        evidenceReference: text(formData, 'evidenceReference'),
        expectedUpdatedAt: date(
          text(formData, 'expectedUpdatedAt'),
          'expectedUpdatedAt'
        ),
        operationId: text(formData, 'operationId'),
        reason: text(formData, 'reason')
      }
    );
    dependencies.revalidate('/platform-admin/retention');
    dependencies.redirect(
      `/platform-admin/retention?result=${encodeURIComponent(resultCode(result))}`
    );
  },

  async completeExportRequest(formData: FormData): Promise<void> {
    const session = await dependencies.getOwnerSession();
    const result = await dependencies.service.completeExportRequest(
      session.userId,
      {
        organisationId: text(formData, 'organisationId'),
        requestId: text(formData, 'requestId'),
        expectedVersion: Number(text(formData, 'expectedVersion')),
        operationId: text(formData, 'operationId'),
        deliveryReference: text(formData, 'deliveryReference')
      }
    );
    dependencies.revalidate('/platform-admin/retention');
    dependencies.redirect(
      `/platform-admin/retention?result=${encodeURIComponent(resultCode(result))}`
    );
  }
});

const productionActions = () =>
  createRetentionActionHandlers({
    getOwnerSession: async () =>
      requirePlatformOwner(
        new Request('http://localhost/platform-admin/retention', {
          headers: await headers()
        })
      ),
    service: getRetentionOperationsService(),
    revalidate: revalidatePath,
    redirect
  });

export const recordVerifiedRequestAction = async (
  formData: FormData
): Promise<void> => {
  'use server';
  return productionActions().recordVerifiedRequest(formData);
};

export const reviewDataRequestAction = async (
  formData: FormData
): Promise<void> => {
  'use server';
  return productionActions().reviewRequest(formData);
};

export const recordBackupExpiryVerificationAction = async (
  formData: FormData
): Promise<void> => {
  'use server';
  return productionActions().recordBackupExpiryVerification(formData);
};

export const completeExportRequestAction = async (
  formData: FormData
): Promise<void> => {
  'use server';
  return productionActions().completeExportRequest(formData);
};
