'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  getSubscriptionService,
  requireWebSession
} from '../../../../server/runtime.js';

const organisationIdFrom = (formData: FormData): string => {
  const value = formData.get('organisationId');
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('organisationId is required');
  }
  return value.trim();
};

const context = async () => ({
  session: await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  ),
  service: await getSubscriptionService()
});

export async function startSoloCheckout(formData: FormData): Promise<void> {
  const { session, service } = await context();
  const hosted = await service.createCheckout(
    session,
    organisationIdFrom(formData)
  );
  redirect(hosted.url);
}

export async function openBillingPortal(formData: FormData): Promise<void> {
  const { session, service } = await context();
  const hosted = await service.createPortal(
    session,
    organisationIdFrom(formData)
  );
  redirect(hosted.url);
}
