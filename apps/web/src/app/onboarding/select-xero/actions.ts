'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  getXeroOAuthService,
  requireWebIdentitySession
} from '../../../server/runtime.js';

const required = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

export async function selectSoloXeroTenant(formData: FormData): Promise<void> {
  const session = await requireWebIdentitySession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const selected = required(formData, 'selection').split('|');
  const connectionId = selected[0];
  const tenantId = selected[1];
  if (!connectionId || !tenantId || selected.length !== 2) {
    throw new Error('selection is invalid');
  }
  const result = await getXeroOAuthService().selectSoloTenant(session, {
    pendingAuthorisationId: required(formData, 'pendingAuthorisationId'),
    connectionId,
    tenantId
  });
  redirect(
    result.initialSyncQueued
      ? '/onboarding?sync=queued'
      : '/onboarding?sync=retry'
  );
}
