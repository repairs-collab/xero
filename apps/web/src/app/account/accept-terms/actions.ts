'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  recordCurrentLegalAcceptance,
  safeLocalReturnTo
} from '../../../server/legal-acceptance.js';
import {
  getDatabaseClient,
  requireWebRawIdentitySession
} from '../../../server/runtime.js';

export async function acceptLegalTerms(formData: FormData): Promise<never> {
  const returnToValue = formData.get('returnTo');
  const returnTo = safeLocalReturnTo(
    typeof returnToValue === 'string' ? returnToValue : undefined
  );
  if (
    formData.get('termsAccepted') !== 'yes' ||
    formData.get('privacyAccepted') !== 'yes' ||
    formData.get('acceptableUseAccepted') !== 'yes'
  ) {
    redirect(
      `/account/accept-terms?error=required&returnTo=${encodeURIComponent(
        returnTo
      )}`
    );
  }
  const session = await requireWebRawIdentitySession(
    new Request('http://localhost/account/accept-terms', {
      headers: await headers()
    })
  );
  await recordCurrentLegalAcceptance(getDatabaseClient().db, {
    userId: session.userId,
    acceptedAt: new Date()
  });
  redirect(returnTo);
}
