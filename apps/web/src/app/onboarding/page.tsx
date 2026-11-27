import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  getOnboardingService,
  requireWebAcceptedIdentitySession
} from '../../server/runtime.js';
import { legalIdentity } from '../../server/legal-content.js';
import { LegalAcceptanceRequired } from '../../server/legal-acceptance.js';
import {
  confirmBusinessDetails,
  confirmSequenceReview
} from './actions.js';

export default async function SelfServiceOnboardingPage({
  searchParams
}: {
  searchParams: Promise<{ sync?: string }>;
}) {
  const support = legalIdentity();
  let session;
  try {
    session = await requireWebAcceptedIdentitySession(
      new Request('http://localhost/', { headers: await headers() })
    );
  } catch (error) {
    if (error instanceof LegalAcceptanceRequired) {
      redirect('/account/accept-terms?returnTo=%2Fonboarding');
    }
    throw error;
  }
  const parameters = await searchParams;
  const activeMembership = session.memberships.find((value) => value.active);

  if (activeMembership !== undefined) {
    const status = await getOnboardingService().getStatus(
      session,
      activeMembership.organisationId
    );
    const xeroConnected = status.steps.some(
      (step) => step.key === 'XERO_CONNECTED' && step.complete
    );
    return (
      <main className="content page-stack onboarding-page">
        <section className="panel">
          <span className="eyebrow">Customer onboarding</span>
          <h1>
            {xeroConnected
              ? 'Your Xero organisation is connected'
              : 'Complete your AccountPulse setup'}
          </h1>
          <p>Review and approve reminders before they are sent.</p>
          {!xeroConnected ? (
            <div className="callout callout--warning">
              <strong>Connect Xero to begin</strong>
              <p>
                Choose the Xero organisation this AccountPulse workspace will
                manage. You must be authorised to connect it.
              </p>
              <Link
                className="button button--primary"
                href={`/xero/connect?organisationId=${encodeURIComponent(
                  activeMembership.organisationId
                )}&returnTo=%2Fonboarding`}
              >
                Connect Xero
              </Link>
            </div>
          ) : parameters.sync === 'retry' ? (
            <div className="callout callout--warning">
              <strong>The first sync needs another attempt</strong>
              <Link href="/settings/integrations">Retry the sync in Integrations</Link>
            </div>
          ) : null}
          {status.trial.readOnly && (
            <div className="callout callout--warning" role="status">
              <strong>Payment is required to activate AccountPulse</strong>
              <p>Subscribe to send customer reminders.</p>
              <div className="button-row">
                <Link href="/settings/billing" className="button button--primary">
                  Subscribe
                </Link>
                <Link href="/settings/integrations" className="button">
                  Disconnect Xero
                </Link>
              </div>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="onboarding-progress">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Onboarding progress</span>
              <h2 id="onboarding-progress">
                {status.completedCount} of {status.steps.length} complete
              </h2>
            </div>
            <span className="status-chip">
              {status.complete ? 'Ready' : 'Setup required'}
            </span>
          </div>
          <div className="page-stack">
            {status.steps.map((step) => (
              <article className="sequence-card" key={step.key}>
                <div>
                  <span className="eyebrow">
                    {step.complete
                      ? 'Complete'
                      : step.key === 'REPLY_NUMBER_READY'
                        ? 'Waiting for AccountPulse'
                        : 'Action required'}
                  </span>
                  <h3>{step.label}</h3>
                  <p>{step.description}</p>
                </div>
                {!step.complete && step.key === 'BUSINESS_DETAILS' ? (
                  <form action={confirmBusinessDetails} id="business-details">
                    <input
                      type="hidden"
                      name="organisationId"
                      value={activeMembership.organisationId}
                    />
                    <button className="button button--primary">
                      Confirm details
                    </button>
                  </form>
                ) : !step.complete && step.key === 'SEQUENCE_REVIEWED' ? (
                  <form action={confirmSequenceReview}>
                    <input
                      type="hidden"
                      name="organisationId"
                      value={activeMembership.organisationId}
                    />
                    <div className="button-row">
                      <Link className="button" href={step.href}>
                        Open sequences
                      </Link>
                      <button className="button button--primary">
                        Confirm Review mode
                      </button>
                    </div>
                  </form>
                ) : !step.complete && step.key !== 'REPLY_NUMBER_READY' ? (
                  <Link className="button" href={step.href}>
                    Continue
                  </Link>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="button-row">
            <Link href="/" className="button button--primary">
              Continue to AccountPulse
            </Link>
            <Link href="/settings/integrations" className="button">
              View integrations
            </Link>
          </div>
          <p className="muted-copy">
            AccountPulse Solo supports one Xero organisation. To register
            interest in multiple organisations, contact{' '}
            <a href={`mailto:${support.supportEmail}`}>{support.supportEmail}</a>{' '}
            for the Enterprise waitlist.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="public-page">
      <section className="public-card">
        <h1>Connect your Xero organisation</h1>
        <p>
          AccountPulse requests the minimum accounting access needed to sync
          invoices and contacts. You will choose one Xero organisation next.
        </p>
        <Link
          href="/xero/connect?purpose=solo"
          className="button button--primary"
        >
          Connect Xero
        </Link>
        <p className="muted-copy">
          Review and approve reminders before they are sent.
        </p>
      </section>
    </main>
  );
}
