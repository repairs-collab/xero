'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  getXeroOAuthService,
  requireWebAcceptedSession
} from '../../../../../../server/runtime.js';

const required = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

export async function selectXeroTenant(formData: FormData): Promise<void> {
  const session = await requireWebAcceptedSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  await getXeroOAuthService().selectTenant(session, {
    organisationId: required(formData, 'organisationId'),
    pendingAuthorisationId: required(formData, 'pendingAuthorisationId'),
    connectionId: required(formData, 'connectionId'),
    tenantId: required(formData, 'tenantId')
  });
  redirect('/settings/integrations');
}
