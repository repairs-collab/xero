import type { PlatformAuditPage } from '@bc5000/db/web';

const label = (value: string): string =>
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase());

const safeKeys = new Set([
  'status',
  'platformStatus',
  'platformStatusVersion',
  'includedParts',
  'warningPercent',
  'role',
  'active',
  'trialEndsAt',
  'currentPeriodEnd',
  'organisationId',
  'quarantineUntil'
]);

const safeChanges = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): string[] => {
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {})
  ]);
  return [...keys]
    .filter((key) => safeKeys.has(key))
    .flatMap((key) => {
      const oldValue = before?.[key];
      const newValue = after?.[key];
      if (oldValue === newValue || (oldValue === undefined && newValue === undefined)) return [];
      const left = oldValue === undefined || oldValue === null ? '—' : String(oldValue);
      const right = newValue === undefined || newValue === null ? '—' : String(newValue);
      return [`${label(key)}: ${left} → ${right}`];
    });
};

export function PlatformAuditList({
  page,
  filters
}: {
  page: PlatformAuditPage;
  filters: {
    organisationId?: string;
    actorUserId?: string;
    eventType?: string;
    from?: string;
    to?: string;
  };
}) {
  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading"><div><span className="eyebrow">Accountability</span><h1>Platform audit history</h1><p>Owner actions with customer, reason and safe state changes.</p></div></header>
      <section className="panel platform-table-panel">
        <form className="platform-filters platform-audit-filters" method="get">
          <strong>Filter audit history</strong>
          <label>Customer ID<input name="organisationId" defaultValue={filters.organisationId ?? ''} /></label>
          <label>Actor ID<input name="actorUserId" defaultValue={filters.actorUserId ?? ''} /></label>
          <label>Event<input name="eventType" defaultValue={filters.eventType ?? ''} /></label>
          <label>From<input type="date" name="from" defaultValue={filters.from ?? ''} /></label>
          <label>To<input type="date" name="to" defaultValue={filters.to ?? ''} /></label>
          <button className="button button--primary" type="submit">Apply</button>
        </form>
        <div className="platform-audit-list">
          {page.items.map((item) => (
            <article key={item.id}>
              <header><div><strong>{label(item.eventType)}</strong><span>{item.organisationName ?? 'Platform-wide'}</span></div><time>{new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(item.occurredAt)}</time></header>
              <p>{item.reason}</p>
              <div className="platform-audit-meta"><span>{item.actorDisplayName} · {item.actorEmail}</span><span>{item.entityType} · {item.entityId}</span></div>
              {safeChanges(item.beforeValue, item.afterValue).map((change) => <small key={change}>{change}</small>)}
            </article>
          ))}
          {page.items.length === 0 ? <p className="platform-empty">No audit events matched these filters.</p> : null}
        </div>
      </section>
    </div>
  );
}
