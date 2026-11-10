'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  getMobileVerificationService,
  getOnboardingService,
  requireWebSession
} from '../../server/runtime.js';

const organisationIdFrom = (formData: FormData): string => {
  const value = formData.get('organisationId');
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('organisationId is required');
  }
  return value.trim();
};

const sessionForAction = async () =>
  requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );

export async function confirmBusinessDetails(
  formData: FormData
): Promise<void> {
  const organisationId = organisationIdFrom(formData);
  await getOnboardingService().confirmBusinessDetails(
    await sessionForAction(),
    organisationId
  );
  revalidatePath('/onboarding');
}

export async function confirmSequenceReview(
  formData: FormData
): Promise<void> {
  const organisationId = organisationIdFrom(formData);
  await getOnboardingService().confirmSequenceReview(
    await sessionForAction(),
    organisationId
  );
  revalidatePath('/onboarding');
}

export async function requestAdminMobileCode(
  formData: FormData
): Promise<void> {
  const organisationId = organisationIdFrom(formData);
  const mobile = formData.get('mobile');
  if (typeof mobile !== 'string' || mobile.trim() === '') {
    throw new Error('mobile is required');
  }
  await getMobileVerificationService().requestCode(await sessionForAction(), {
    organisationId,
    mobile
  });
  redirect('/onboarding?mobile=sent');
}

export async function verifyAdminMobileCode(
  formData: FormData
): Promise<void> {
  const organisationId = organisationIdFrom(formData);
  const code = formData.get('code');
  if (typeof code !== 'string') throw new Error('code is required');
  const result = await getMobileVerificationService().verifyCode(
    await sessionForAction(),
    { organisationId, code }
  );
  if (result !== 'VERIFIED') {
    throw new Error(`MOBILE_VERIFICATION_${result}`);
  }
  revalidatePath('/onboarding');
  revalidatePath('/settings/test-sms');
  redirect('/onboarding?mobile=verified');
}
