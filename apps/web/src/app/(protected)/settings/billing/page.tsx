import { headers } from 'next/headers';
import Link from 'next/link';
import { billingStatus } from './billing-status.js';
import { isTerminalStripeSubscription } from '../../../../server/subscription-service.js';

import {
  getBillingAccountSnapshot,
  isStripeBillingConfigured,
  getSmsCommerceRepository,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  openBillingPortal,
  requestDirectDebit,
  startSoloCheckout
} from './actions.js';

const monthlyPriceExcludingGstCents = 29_900;
const smsOverageCentsPerPart = 11;
const annualPriceExcludingGstCents =
  (monthlyPriceExcludingGstCents * 12 * 95) / 100;
const gstCents = (excludingGstCents: number): number =>
  excludingGstCents / 10;
const aud = (cents: number): string =>
  new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(cents / 100);

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

export default async function BillingSettingsPage({
  searchParams
}: {
  searchParams?: Promise<{
    checkout?: string | string[];
    checkoutCadence?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const checkoutConflict = query?.checkout === 'attempt-conflict';
  const checkoutConflictCadence =
    checkoutConflict &&
    (query?.checkoutCadence === 'MONTHLY' || query?.checkoutCadence === 'ANNUAL')
      ? query.checkoutCadence
      : null;
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const membership = session.memberships[0];
  if (membership === undefined) throw new Error('No active organisation membership');
  const account = await getBillingAccountSnapshot(
    session,
    membership.organisationId
  );
  const billing = billingStatus(account, new Date());
  const effectiveStatus = billing.status;
  const stripeConfigured = isStripeBillingConfigured();
  const smsCommerce = getSmsCommerceRepository();
  const smsUsage = await smsCommerce.loadUsage(
    membership.organisationId
  );
  const smsAllowance =
    smsUsage ?? (await smsCommerce.loadAllowance(membership.organisationId));
  const admin = membership.role === 'ADMIN';
  const legacySmsExempt = account.edition === 'INTERNAL_LEGACY';
  const usedSmsParts =
    smsUsage === null
      ? 0
      : smsUsage.committedParts + smsUsage.reservedParts;
  const includedSmsParts = smsAllowance.includedParts;
  const remainingSmsParts = smsUsage?.remainingParts ?? includedSmsParts;
  const overageSmsParts = Math.max(0, usedSmsParts - includedSmsParts);
  const estimatedOverageCents = overageSmsParts * smsOverageCentsPerPart;

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">
          {legacySmsExempt ? 'AccountPulse' : 'AccountPulse Solo'}
        </span>
        <h1>Plan and billing</h1>
        <p>
          Manage the subscription in Stripe. AccountPulse never receives or
          stores your card number.
        </p>
      </header>

      {checkoutConflict && admin && !legacySmsExempt ? (
        <div className="callout callout--warning" role="status">
          <strong>A Stripe checkout is already in progress</strong>
          <p>
            {checkoutConflictCadence === null
              ? 'Choose the same billing option to reopen it if it is still available.'
              : `${checkoutConflictCadence === 'MONTHLY' ? 'Monthly' : 'Annual'} checkout is already in progress. Reopen that checkout to continue.`}{' '}
            You can change billing options after Stripe confirms the earlier checkout has expired or ended.
          </p>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel__header">
          <div>
            <span className="eyebrow">Current plan</span>
            {legacySmsExempt ? (
              <h2>Internal legacy account</h2>
            ) : (
              <h2>
                Solo — {includedSmsParts.toLocaleString('en-AU')} SMS parts per
                monthly allowance period
              </h2>
            )}
          </div>
          <span className="status-pill">{statusLabels[effectiveStatus]}</span>
        </div>
        <dl className="detail-grid">
          <div>
            <dt>Status</dt>
            <dd>{statusLabels[effectiveStatus]}</dd>
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

      {!legacySmsExempt ? (
        <section className="panel">
          <div className="panel__header">
            <div>
              <span className="eyebrow">Plan options</span>
              <h2>Choose monthly or annual card billing</h2>
            </div>
          </div>
          <div className="detail-grid">
            {(
              [
                {
                  cadence: 'MONTHLY' as const,
                  title: 'Monthly',
                  excludingGstCents: monthlyPriceExcludingGstCents,
                  note: 'Billed monthly'
                },
                {
                  cadence: 'ANNUAL' as const,
                  title: 'Annual',
                  excludingGstCents: annualPriceExcludingGstCents,
                  note: '5% less than twelve monthly charges'
                }
              ] as const
            ).map((plan) => {
              const gst = gstCents(plan.excludingGstCents);
              const total = plan.excludingGstCents + gst;
              const checkoutAvailable =
                stripeConfigured &&
                admin &&
                (account.stripeSubscriptionId === null ||
                  (account.status === 'CANCELLED' &&
                    isTerminalStripeSubscription(account.stripeProviderStatus)));
              const blockedByOtherCheckout =
                checkoutConflictCadence !== null &&
                checkoutConflictCadence !== plan.cadence;
              return (
                <article key={plan.cadence}>
                  <h3>{plan.title}</h3>
                  <p>
                    <strong>
                      {aud(plan.excludingGstCents)} AUD excluding GST
                    </strong>
                  </p>
                  <p>
                    GST {aud(gst)}; payable total {aud(total)}.
                  </p>
                  <p>{plan.note}.</p>
                  {checkoutAvailable && !blockedByOtherCheckout ? (
                    <form action={startSoloCheckout}>
                      <input
                        type="hidden"
                        name="organisationId"
                        value={account.organisationId}
                      />
                      <input
                        type="hidden"
                        name="billingCadence"
                        value={plan.cadence}
                      />
                      <button className="button button--primary">
                        {checkoutConflictCadence === plan.cadence
                          ? `Reopen ${plan.title.toLocaleLowerCase('en-AU')} checkout`
                          : `Choose ${plan.title.toLocaleLowerCase('en-AU')}`}
                      </button>
                    </form>
                  ) : blockedByOtherCheckout ? (
                    <p className="muted-copy">
                      {plan.title} unavailable while{' '}
                      {checkoutConflictCadence.toLocaleLowerCase('en-AU')}{' '}
                      checkout is in progress.
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
          <p className="muted-copy">
            Each plan includes{' '}
            {includedSmsParts.toLocaleString('en-AU')} included SMS parts reset
            every month. Additional parts cost A$0.11 each excluding GST.
            Unused parts do not roll over. First payment is collected by card
            on signup.
          </p>
        </section>
      ) : null}

      {legacySmsExempt ? (
        <section className="panel">
          <div className="panel__header">
            <div>
              <span className="eyebrow">SMS usage</span>
              <h2>{usedSmsParts.toLocaleString('en-AU')} parts recorded</h2>
            </div>
            <span className="status-pill">Allowance exempt</span>
          </div>
          <dl className="detail-grid">
            <div>
              <dt>Sent or accepted</dt>
              <dd>{(smsUsage?.committedParts ?? 0).toLocaleString('en-AU')}</dd>
            </div>
            <div>
              <dt>Reserved while delivery outcome is checked</dt>
              <dd>{(smsUsage?.reservedParts ?? 0).toLocaleString('en-AU')}</dd>
            </div>
            <div>
              <dt>Used this monthly allowance period</dt>
              <dd>{usedSmsParts.toLocaleString('en-AU')}</dd>
            </div>
          </dl>
          <p className="muted-copy">
            This internal legacy account is not subject to the Solo SMS
            allowance. Usage is shown for monitoring only.
          </p>
        </section>
      ) : (
      <section className="panel">
        <div className="panel__header">
          <div>
            <span className="eyebrow">Included SMS</span>
            <h2>
              {usedSmsParts.toLocaleString('en-AU')} of{' '}
              {includedSmsParts.toLocaleString('en-AU')} parts used
            </h2>
          </div>
          <span className="status-pill">Paid overage enabled</span>
        </div>
        <progress
          max={includedSmsParts}
          value={Math.min(usedSmsParts, includedSmsParts)}
          aria-label="Monthly SMS parts used"
        />
        <dl className="detail-grid">
          <div>
            <dt>Sent or accepted</dt>
            <dd>{(smsUsage?.committedParts ?? 0).toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Reserved while delivery outcome is checked</dt>
            <dd>{(smsUsage?.reservedParts ?? 0).toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Used this monthly allowance period</dt>
            <dd>{usedSmsParts.toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Included each monthly allowance period</dt>
            <dd>{includedSmsParts.toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Remaining this monthly allowance period</dt>
            <dd>{remainingSmsParts.toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Overage parts this monthly allowance period</dt>
            <dd>{overageSmsParts.toLocaleString('en-AU')}</dd>
          </div>
          <div>
            <dt>Estimated overage excluding GST</dt>
            <dd>{aud(estimatedOverageCents)}</dd>
          </div>
        </dl>
        <p className="muted-copy">
          The first {includedSmsParts.toLocaleString('en-AU')} outbound SMS
          parts are included in each monthly allowance period. Additional
          outbound parts are billed at A$0.11 excluding GST per additional SMS
          part. Reserved parts are included in this estimate until their
          delivery outcome is resolved. Unused included parts do not roll over.
        </p>
        {smsUsage !== null &&
        usedSmsParts * 100 >=
          smsUsage.includedParts * smsUsage.warningPercent ? (
          <div className="callout callout--warning">
            <strong>SMS allowance is running low</strong>
            <p>
              Additional outbound SMS parts are billed as paid overage after
              the included allowance is used.
            </p>
          </div>
        ) : null}
      </section>
      )}

      {billing.warning === 'ended' ? (
        <section className="callout callout--warning">
          <strong>Subscription ended</strong>
          <p>Customer sending is paused. Manage your subscription in Stripe or contact support to renew or resubscribe.</p>
        </section>
      ) : billing.warning === 'payment' ? (
        <section className="callout callout--warning">
          <strong>Customer sending is paused</strong>
          <p>
            Resolve billing in Stripe, then return to Sending controls to
            explicitly resume customer sending. A payment redirect alone never
            changes access.
          </p>
        </section>
      ) : null}

      {!legacySmsExempt &&
      ((account.initialCardInvoiceId !== null &&
        account.initialCardPaymentSucceededAt !== null) ||
        account.directDebitStatus === 'RECONCILIATION_REQUIRED') ? (
        <section className="panel">
          <div className="panel__header">
            <div>
              <span className="eyebrow">Payment method exception</span>
              <h2>Australian direct debit</h2>
            </div>
            <span className="status-pill">
              {account.directDebitStatus === 'RECONCILIATION_REQUIRED'
                ? 'Reconciliation required'
                : (account.directDebitStatus ?? 'Not requested')}
            </span>
          </div>
          <p>
            Direct debit is available only on request after the first
            successful card payment. Each request is reviewed manually. If it
            proceeds, AccountPulse sends the requesting customer a
            Stripe-hosted setup link. Direct debit is not enabled
            automatically, and AccountPulse never receives or stores bank
            details.
          </p>
          {account.directDebitStatus === 'RECONCILIATION_REQUIRED' ? (
            <div className="callout callout--warning">
              <strong>Reconciliation required</strong>
              <p>
                A previous direct-debit record needs review before another
                request can be made. Contact support.
              </p>
            </div>
          ) : null}
          {admin && account.directDebitStatus === null ? (
            <form action={requestDirectDebit}>
              <input
                type="hidden"
                name="organisationId"
                value={account.organisationId}
              />
              <button className="button">Request direct debit</button>
            </form>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <h2>Billing actions</h2>
        {legacySmsExempt ? (
          <div className="button-row">
            <p>This internal legacy account does not use customer Stripe billing.</p>
            <Link href="/settings/sending" className="button">
              Sending controls
            </Link>
          </div>
        ) : !stripeConfigured ? (
          <div className="callout callout--warning" role="status">
            <strong>Online billing setup is temporarily unavailable</strong>
            <p>
              Your AccountPulse data remains safe. Contact support for billing
              help; no card details can be entered on this page while online
              billing is unavailable.
            </p>
          </div>
        ) : admin ? (
          <div className="button-row">
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
