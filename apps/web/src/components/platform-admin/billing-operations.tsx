import Link from 'next/link';

import type { PlatformBillingOperationsPage } from '@bc5000/db/web';

export interface PlatformBillingOperationsFilters {
  organisationId: string;
  caseKind: string;
  caseStatus: string;
  casesCursor: string;
  heldEmailsCursor: string;
}

const label = (value: string): string =>
  value
    .toLocaleLowerCase('en-AU')
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toLocaleUpperCase('en-AU'));

const dateTime = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney'
  }).format(value);

const money = (amountMinor: number, currency: string): string =>
  new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: currency.toLocaleUpperCase('en-AU')
  }).format(amountMinor / 100);

export function PlatformBillingOperations({
  page,
  filters
}: {
  page: PlatformBillingOperationsPage;
  filters: PlatformBillingOperationsFilters;
}) {
  const continuationHref = (
    key: 'casesCursor' | 'heldEmailsCursor',
    cursor: string
  ): string => {
    const params = new URLSearchParams();
    const filterEntries: Array<[string, string]> = [
      ['organisationId', filters.organisationId],
      ['caseKind', filters.caseKind],
      ['caseStatus', filters.caseStatus],
      ['casesCursor', filters.casesCursor],
      ['heldEmailsCursor', filters.heldEmailsCursor]
    ];
    for (const [name, value] of filterEntries) {
      if (value) params.set(name, value);
    }
    params.set(key, cursor);
    return `/platform-admin/billing?${params.toString()}`;
  };

  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <span className="eyebrow">Payment safety</span>
          <h1>Billing operations</h1>
          <p>
            Read-only Stripe evidence for payment failures, refunds and
            disputes. Account access remains protected until blocking cases
            are resolved and explicitly reviewed.
          </p>
        </div>
      </header>

      <section className="panel platform-table-panel">
        <form className="platform-filters" method="get">
          <strong>Filter billing evidence</strong>
          <label>
            Customer ID
            <input
              name="organisationId"
              defaultValue={filters.organisationId}
              placeholder="Exact customer ID"
            />
          </label>
          <label>
            Case type
            <select name="caseKind" defaultValue={filters.caseKind}>
              <option value="">All types</option>
              <option value="PAYMENT_FAILURE">Payment failure</option>
              <option value="REFUND">Refund</option>
              <option value="DISPUTE">Dispute</option>
            </select>
          </label>
          <label>
            Case status
            <select name="caseStatus" defaultValue={filters.caseStatus}>
              <option value="">All statuses</option>
              <option value="OPEN">Open</option>
              <option value="REVIEW_REQUIRED">Review required</option>
              <option value="RESOLVED">Resolved</option>
            </select>
          </label>
          <button className="button button--primary" type="submit">
            Apply filters
          </button>
        </form>
      </section>

      <section className="panel platform-table-panel" aria-labelledby="billing-cases-heading">
        <header className="platform-page-heading">
          <div>
            <span className="eyebrow">Financial risk</span>
            <h2 id="billing-cases-heading">Cases</h2>
            <p>Newest evidence first. Case state can only change through verified provider events.</p>
          </div>
        </header>
        <div className="platform-audit-list">
          {page.cases.items.map((item) => (
            <article key={item.id}>
              <header>
                <div>
                  <strong>{label(item.kind)} · {label(item.status)}</strong>
                  <Link href={`/platform-admin/organisations/${item.organisationId}`}>
                    {item.organisationName}
                  </Link>
                </div>
                <time>{dateTime(item.createdAt)}</time>
              </header>
              <p>
                {money(item.amountMinor, item.currency)} · {item.providerObjectType}{' '}
                {item.providerReference}
              </p>
              <div className="platform-audit-meta">
                <span>{label(item.subscriptionRelation)} subscription</span>
                <span>{item.blocksSending ? 'Sending blocked' : 'Review only'}</span>
                <span>Provider state: {label(item.providerStatus)}</span>
              </div>
              <small>
                Opened {dateTime(item.openedAt)}
                {item.resolvedAt ? ` · Resolved ${dateTime(item.resolvedAt)}` : ''}
              </small>
            </article>
          ))}
          {page.cases.items.length === 0 ? (
            <p className="platform-empty">No billing cases matched these filters.</p>
          ) : null}
        </div>
        {page.cases.nextCursor ? (
          <nav className="platform-pagination" aria-label="More billing cases">
            <span />
            <Link href={continuationHref('casesCursor', page.cases.nextCursor)}>
              More cases →
            </Link>
          </nav>
        ) : null}
      </section>

      <section className="panel platform-table-panel" aria-labelledby="held-notices-heading">
        <header className="platform-page-heading">
          <div>
            <span className="eyebrow">Held — not delivered</span>
            <h2 id="held-notices-heading">Customer notices</h2>
            <p>
              These records are evidence only. They have not been emailed and
              this page has no send or release control.
            </p>
          </div>
        </header>
        <div className="platform-audit-list">
          {page.heldEmails.items.map((item) => (
            <article key={item.id}>
              <header>
                <div>
                  <strong>{label(item.template)}</strong>
                  <Link href={`/platform-admin/organisations/${item.organisationId}`}>
                    {item.organisationName}
                  </Link>
                </div>
                <time>{dateTime(item.createdAt)}</time>
              </header>
              <p>{item.recipient}</p>
              <div className="platform-audit-meta">
                <span>Held — not delivered</span>
                <span>Case {item.billingCaseId}</span>
              </div>
            </article>
          ))}
          {page.heldEmails.items.length === 0 ? (
            <p className="platform-empty">No held notices matched this customer.</p>
          ) : null}
        </div>
        {page.heldEmails.nextCursor ? (
          <nav className="platform-pagination" aria-label="More held notices">
            <span />
            <Link
              href={continuationHref(
                'heldEmailsCursor',
                page.heldEmails.nextCursor
              )}
            >
              More held notices →
            </Link>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
