'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  getSubscriptionService,
  requireWebAcceptedSession
} from '../../../../server/runtime.js';

import { SubscriptionFailure } from '../../../../server/subscription-service.js';

const organisationIdFrom = (formData: FormData): string => {
  const value = formData.get('organisationId');
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('organisationId is required');
  }
  return value.trim();
};

const billingCadenceFrom = (
  formData: FormData
): 'MONTHLY' | 'ANNUAL' => {
  const value = formData.get('billingCadence');
  if (value !== 'MONTHLY' && value !== 'ANNUAL') {
    throw new Error('billingCadence is invalid');
  }
  return value;
};

const context = async () => ({
  session: await requireWebAcceptedSession(
    new Request('http://localhost/', { headers: await headers() })
  ),
  service: await getSubscriptionService()
});

export async function startSoloCheckout(formData: FormData): Promise<void> {
  const { session, service } = await context();
  const hosted = await service.createCheckout(
    session,
    organisationIdFrom(formData),
    billingCadenceFrom(formData)
  ).catch((error: unknown) => {
    if (error instanceof SubscriptionFailure && error.code === 'CHECKOUT_ATTEMPT_CONFLICT') {
      redirect('/settings/billing?checkout=attempt-conflict');
    }
    throw error;
  });
  redirect(hosted.url);
}

export async function requestDirectDebit(formData: FormData): Promise<void> {
  const { session, service } = await context();
  await service.requestDirectDebit(session, organisationIdFrom(formData));
  redirect('/settings/billing?direct_debit=requested');
}

export async function openBillingPortal(formData: FormData): Promise<void> {
  const { session, service } = await context();
  const hosted = await service.createPortal(
    session,
    organisationIdFrom(formData)
  );
  redirect(hosted.url);
}
