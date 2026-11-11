import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AuthenticationFailure } from '@bc5000/auth';

import {
  currentLegalVersions,
  hasCurrentLegalAcceptance,
  safeLocalReturnTo
} from '../../../server/legal-acceptance.js';
import { legalIdentity } from '../../../server/legal-content.js';
import {
  getDatabaseClient,
  requireWebRawIdentitySession
} from '../../../server/runtime.js';
import { acceptLegalTerms } from './actions.js';

export default async function AcceptTermsPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const parameters = await searchParams;
  const returnTo = safeLocalReturnTo(parameters.returnTo);
  let session;
  try {
    session = await requireWebRawIdentitySession(
      new Request('http://localhost/account/accept-terms', {
        headers: await headers()
      })
    );
  } catch (error) {
    if (error instanceof AuthenticationFailure) {
      redirect(
        `/auth/login?returnTo=${encodeURIComponent(
          `/account/accept-terms?returnTo=${encodeURIComponent(returnTo)}`
        )}`
      );
    }
    throw error;
  }
  if (
    await hasCurrentLegalAcceptance(getDatabaseClient().db, session.userId)
  ) {
    redirect(returnTo);
  }
  const legal = legalIdentity();
  return (
    <main className="public-page" id="main-content">
      <section className="public-card legal-consent-card">
        <span className="eyebrow">Account setup</span>
        <h1>Review and accept the AccountPulse terms</h1>
        <p>
          Welcome, {session.displayName}. Before accessing customer and Xero
          data, please review the agreements for AccountPulse, operated by{' '}
          {legal.entity}.
        </p>
        {parameters.error === 'required' ? (
          <div className="callout callout--warning" role="alert">
            <strong>All three confirmations are required</strong>
            <p>Open each document and confirm your acceptance to continue.</p>
          </div>
        ) : null}
        <form action={acceptLegalTerms} className="page-stack">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="legal-consent-option">
            <input type="checkbox" name="termsAccepted" value="yes" required />
            <span>
              I accept the{' '}
              <Link href="/legal/terms" target="_blank">
                Terms of Service
              </Link>{' '}
              (version {currentLegalVersions.terms}).
            </span>
          </label>
          <label className="legal-consent-option">
            <input type="checkbox" name="privacyAccepted" value="yes" required />
            <span>
              I acknowledge the{' '}
              <Link href="/legal/privacy" target="_blank">
                Privacy Policy
              </Link>{' '}
              (version {currentLegalVersions.privacy}).
            </span>
          </label>
          <label className="legal-consent-option">
            <input
              type="checkbox"
              name="acceptableUseAccepted"
              value="yes"
              required
            />
            <span>
              I accept the{' '}
              <Link href="/legal/acceptable-use" target="_blank">
                Acceptable Use and Messaging Policy
              </Link>{' '}
              (version {currentLegalVersions.acceptableUse}).
            </span>
          </label>
          <button className="button button--primary" type="submit">
            Accept and continue
          </button>
        </form>
        <p className="muted-copy">
          Need help? Email{' '}
          <a href={`mailto:${legal.supportEmail}`}>{legal.supportEmail}</a>.
        </p>
      </section>
    </main>
  );
}
