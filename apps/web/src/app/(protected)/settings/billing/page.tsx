import { headers } from 'next/headers';
import Link from 'next/link';

import {
  getBillingAccountSnapshot,
  isStripeBillingConfigured,
  getSmsCommerceRepository,
  requireWebSession
} from '../../../../server/runtime.js';
import { openBillingPortal, startSoloCheckout } from './actions.js';

const statusLabels = {
  TRIALING: 'Free trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment overdue',
  CANCEL_AT_PERIOD_END: 'Cancels at period end',
  CANCELLED: 'Cancelled',
  INCOMPLETE: 'Payment incomplete'
} as const;

const date = (value: Date | null): string =>
  value === null
    ? 'Not available'
    : new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'long',
        timeZone: 'Australia/Sydney'
      }).format(value);

export default async function BillingSettingsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const membership = session.memberships[0];
  if (membership === undefined) throw new Error('No active organisation membership');
  const account = await getBillingAccountSnapshot(
    session,
    membership.organisationId
  );
  const stripeConfigured = isStripeBillingConfigured();
  const smsUsage = await getSmsCommerceRepository().loadUsage(
    membership.organisationId
  );
  const admin = membership.role === 'ADMIN';
  const usedSmsParts =
    smsUsage === null
      ? 0
      : smsUsage.committedParts + smsUsage.reservedParts;

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">AccountPulse Solo</span>
        <h1>Plan and billing</h1>
        <p>
          Manage the subscription in Stripe. AccountPulse never receives or
          stores your card number.
        </p>
      </header>

      <section className="panel">
        <div className="panel__header">
          <div>
            <span className="eyebrow">Current plan</span>
            <h2>Solo — 2,000 SMS parts per month</h2>
          </div>
          <span className="status-pill">{statusLabels[account.status]}</span>
        </div>
        <dl className="detail-grid">
          <div>
            <dt>Status</dt>
            <dd>{statusLabels[account.status]}</dd>
          </div>
          <div>
            <dt>Trial ends</dt>
            <dd>{date(account.trialEndsAt)}</dd>
          </div>
          <div>
            <dt>Current period ends</dt>
            <dd>{date(account.currentPeriodEnd)}</dd>
          </div>
          <div>
            <dt>Cancellation date</dt>
            <dd>{date(account.cancelAt ?? account.cancelledAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <div className="panel__header">
          <div>
            <span className="eyebrow">Included SMS</span>
            <h2>{usedSmsParts.toLocaleString('en-AU')} of 2,000 parts used</h2>
          </div>
          <span className="status-pill">
            {smsUsage?.overageEnabled === true
              ? 'Capped overage enabled'
              : 'No surprise overage'}
          </span>
        </div>
        <progress
          max={smsUsage?.includedParts ?? 2_000}
          value={Math.min(
            usedSmsParts,
            smsUsage?.includedParts ?? 2_000
          )}
          aria-label="Monthly SMS parts used"
        />
        <dl className="detail-grid">
          <div>
            <dt>Sent or accepted</dt>
            <dd>{(smsUsage?.committedParts ?? 0).toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Reserved while provider outcome is checked</dt>
            <dd>{(smsUsage?.reservedParts ?? 0).toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Included each billing period</dt>
            <dd>{(smsUsage?.includedParts ?? 2_000).toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Overage parts</dt>
            <dd>{(smsUsage?.overageParts ?? 0).toLocaleString('en-AU')}</dd>
          </div>
        </dl>
        {smsUsage !== null &&
        usedSmsParts * 100 >=
          smsUsage.includedParts * smsUsage.warningPercent ? (
          <div className="callout callout--warning">
            <strong>SMS allowance is running low</strong>
            <p>
              Sending stops at the included limit unless an Administrator has
              explicitly enabled a priced overage cap.
            </p>
          </div>
        ) : null}
      </section>

      {account.status === 'PAST_DUE' ||
      account.status === 'CANCEL_AT_PERIOD_END' ||
      account.status === 'INCOMPLETE' ? (
        <section className="callout callout--warning">
          <strong>Customer sending is paused</strong>
          <p>
            Resolve billing in Stripe, then return to Sending controls to
            explicitly resume customer sending. A payment redirect alone never
            changes access.
          </p>
        </section>
      ) : null}

      <section className="panel">
        <h2>Billing actions</h2>
        {!stripeConfigured ? (
          <div className="callout callout--warning" role="status">
            <strong>Online billing setup is temporarily unavailable</strong>
            <p>
              Your trial and AccountPulse data are safe. Contact support before
              the trial ends; no card details can be entered on this page while
              billing is unavailable.
            </p>
          </div>
        ) : admin ? (
          <div className="button-row">
            {account.stripeSubscriptionId === null ||
            account.status === 'CANCELLED' ? (
              <form action={startSoloCheckout}>
                <input
                  type="hidden"
                  name="organisationId"
                  value={account.organisationId}
                />
                <button className="button button--primary">
                  Subscribe with Stripe
                </button>
              </form>
            ) : null}
            {account.stripeCustomerId !== null ? (
              <form action={openBillingPortal}>
                <input
                  type="hidden"
                  name="organisationId"
                  value={account.organisationId}
                />
                <button className="button">Manage billing in Stripe</button>
              </form>
            ) : null}
            <Link href="/settings/sending" className="button">
              Sending controls
            </Link>
          </div>
        ) : (
          <p>Ask an Administrator to manage this subscription.</p>
        )}
      </section>
    </div>
  );
}
