import Link from 'next/link';

import type {
  PlatformOrganisationPage,
  PlatformOrganisationSort,
  SortDirection
} from '@bc5000/db/web';

const date = (value: Date | null): string =>
  value
    ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium' }).format(value)
    : '—';

const number = (value: number): string =>
  new Intl.NumberFormat('en-AU').format(value);

export function PlatformAdminOverview({
  page,
  filters
}: {
  page: PlatformOrganisationPage;
  filters: {
    search?: string;
    sort?: PlatformOrganisationSort;
    direction?: SortDirection;
  };
}) {
  const suspended = page.items.filter(
    (item) => item.platformStatus === 'SUSPENDED'
  ).length;
  const trialing = page.items.filter(
    (item) => item.subscription?.status === 'TRIALING'
  ).length;
  const active = page.items.filter(
    (item) => item.platformStatus === 'ACTIVE'
  ).length;
  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <span className="eyebrow">Platform operations</span>
          <h1>Customer overview</h1>
          <p>Manage AccountPulse customers, trials, service state and usage.</p>
        </div>
        <div className="platform-heading-links">
          <Link className="button button--quiet" href="/platform-admin/sms">
            Sinch &amp; SMS
          </Link>
          <Link className="button button--quiet" href="/platform-admin/audit">
            Audit history
          </Link>
        </div>
      </header>

      <section className="platform-kpis" aria-label="Customer totals">
        <article aria-label={`${page.total} ${page.total === 1 ? 'customer' : 'customers'}`}><strong>{page.total}</strong><span>{page.total === 1 ? 'customer' : 'customers'}</span></article>
        <article aria-label={`${active} active`}><strong>{active}</strong><span>active</span></article>
        <article aria-label={`${suspended} suspended`}><strong>{suspended}</strong><span>suspended</span></article>
        <article aria-label={`${trialing} trialing`}><strong>{trialing}</strong><span>trialing</span></article>
      </section>

      <section className="panel platform-table-panel" id="customers">
        <form className="platform-filters" method="get">
          <label>
            Search customers
            <input
              type="search"
              name="search"
              defaultValue={filters.search ?? ''}
              placeholder="Name, email, Xero tenant or SMS number"
            />
          </label>
          <label>
            Sort customers
            <select name="sort" defaultValue={filters.sort ?? 'name'}>
              <option value="name">Name</option>
              <option value="trialEnd">Trial end</option>
              <option value="status">Status</option>
              <option value="usage">SMS usage</option>
            </select>
          </label>
          <label>
            Direction
            <select name="direction" defaultValue={filters.direction ?? 'asc'}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
          <button className="button button--primary" type="submit">Apply</button>
        </form>

        <div className="platform-table platform-customer-table" role="table">
          <div className="platform-table__row platform-table__header" role="row">
            <span>Customer</span><span>Account</span><span>Trial / subscription</span>
            <span>Xero</span><span>SMS usage</span><span>Last sync</span>
          </div>
          {page.items.map((item) => {
            const used = item.smsUsage.committedParts + item.smsUsage.reservedParts;
            return (
              <Link
                href={`/platform-admin/organisations/${item.id}`}
                className="platform-table__row"
                role="row"
                key={item.id}
              >
                <span><strong>{item.name}</strong><small>{item.baseCurrency} · {item.timeZone}</small></span>
                <span><strong>{item.platformStatus}</strong><small>{item.edition}</small></span>
                <span><strong>{item.subscription?.status ?? 'No subscription'}</strong><small>Ends {date(item.subscription?.trialEndsAt ?? null)}</small></span>
                <span><strong>{item.xero?.status ?? 'Not connected'}</strong><small>{item.xero?.tenantId ?? '—'}</small></span>
                <span><strong>{number(used)} / {number(item.smsUsage.includedParts)}</strong><small>{item.smsNumber?.e164Number ?? 'No number'}</small></span>
                <span><strong>{date(item.lastSuccessfulSyncAt)}</strong><small>View customer →</small></span>
              </Link>
            );
          })}
          {page.items.length === 0 ? <p className="platform-empty">No customers matched these filters.</p> : null}
        </div>
      </section>
    </div>
  );
}
