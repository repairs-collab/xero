'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { requirePlatformOwner } from '../../../../server/platform-authorization.js';
import { getPlatformCustomerProvisioningService } from '../../../../server/platform-customer-provisioning.js';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('VALIDATION');
  }
  return value.trim();
};

const integer = (formData: FormData, name: string): number => {
  const value = Number(text(formData, name));
  if (!Number.isSafeInteger(value)) throw new Error('VALIDATION');
  return value;
};

export async function createCustomerAction(formData: FormData): Promise<never> {
  try {
    if (formData.get('confirmed') !== 'on') throw new Error('VALIDATION');
    const session = await requirePlatformOwner(
      new Request('http://localhost/platform-admin/organisations/new', {
        headers: await headers()
      })
    );
    const result = await getPlatformCustomerProvisioningService().createCustomer(
      session,
      {
        name: text(formData, 'name'),
        adminEmail: text(formData, 'adminEmail'),
        adminDisplayName: text(formData, 'adminDisplayName'),
        timeZone: text(formData, 'timeZone') as
          | 'Australia/Sydney'
          | 'Australia/Adelaide'
          | 'Australia/Perth',
        baseCurrency: text(formData, 'baseCurrency') as 'AUD',
        trialDays: integer(formData, 'trialDays'),
        includedSmsParts: integer(formData, 'includedSmsParts'),
        warningPercent: integer(formData, 'warningPercent'),
        reason: text(formData, 'reason')
      }
    );
    redirect(
      `/platform-admin/organisations/${encodeURIComponent(
        result.organisationId
      )}?result=CREATED`
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'digest' in error &&
      typeof error.digest === 'string' &&
      error.digest.startsWith('NEXT_REDIRECT')
    ) {
      throw error;
    }
    redirect('/platform-admin/organisations/new?error=CREATE_FAILED');
  }
}
