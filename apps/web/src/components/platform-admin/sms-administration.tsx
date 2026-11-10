import type { PlatformNumberPage, SmsNumberStatus } from '@bc5000/db/web';

type FormAction = (formData: FormData) => Promise<unknown>;

const title = (value: string): string =>
  value.charAt(0) + value.slice(1).toLowerCase();

const dateTime = (value: Date | null): string =>
  value
    ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
    : '—';

export function PlatformSmsAdministration({
  page,
  organisations,
  filters,
  actions
}: {
  page: PlatformNumberPage;
  organisations: Array<{ id: string; name: string }>;
  filters: { search?: string; status?: SmsNumberStatus | '' };
  actions: {
    register: FormAction;
    assign: FormAction;
    ready: FormAction;
    quarantine: FormAction;
    release: FormAction;
    returnToPool: FormAction;
  };
}) {
  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading"><div><span className="eyebrow">Sinch operations</span><h1>SMS number administration</h1><p>Register, assign, verify and safely cool customer reply numbers.</p></div></header>
      <section className="panel platform-registration-panel">
        <div><h2>Register Sinch number</h2><p>Numbers must be Australian E.164 format, for example +61412345678.</p></div>
        <form action={actions.register as never} className="platform-inline-form">
          <label>Number<input name="e164Number" pattern="[+]61[0-9]{9}" required /></label>
          <label>Sinch provider ID<input name="providerNumberId" /></label>
          <label>Reason<input name="reason" required /></label>
          <button className="button button--primary" type="submit">Register number</button>
        </form>
      </section>
      <section className="panel platform-table-panel">
        <form className="platform-filters" method="get">
          <label>Search numbers<input type="search" name="search" defaultValue={filters.search ?? ''} /></label>
          <label>Status<select name="status" defaultValue={filters.status ?? ''}><option value="">All statuses</option>{(['AVAILABLE','RESERVED','READY','QUARANTINED','RELEASED'] as const).map((status) => <option key={status} value={status}>{title(status)}</option>)}</select></label>
          <button className="button button--primary" type="submit">Apply</button>
        </form>
        <h2 className="platform-subheading">Assign customer</h2>
        <div className="platform-number-list">
          {page.items.map((item) => (
            <article key={item.id}>
              <header><div><strong>{item.e164Number}</strong><span>{item.provider} · {item.providerNumberId ?? 'Provider ID pending'}</span></div><span className={`platform-status platform-status--${item.status.toLowerCase()}`}>{title(item.status)}</span></header>
              <dl><div><dt>Customer</dt><dd>{item.organisationName ?? 'Unassigned'}</dd></div><div><dt>Ready at</dt><dd>{dateTime(item.readyAt)}</dd></div><div><dt>Cooling until</dt><dd>{dateTime(item.quarantineUntil)}</dd></div></dl>
              <div className="platform-number-actions">
                {item.status === 'AVAILABLE' || item.status === 'RELEASED' ? (
                  <form action={actions.assign as never}>
                    <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedStatus" value={item.status} />
                    <select name="organisationId" aria-label={`Customer for ${item.e164Number}`} required><option value="">Select customer</option>{organisations.map((organisation) => <option key={organisation.id} value={organisation.id}>{organisation.name}</option>)}</select>
                    <input name="reason" placeholder="Reason" required /><button className="button button--primary" type="submit">Assign customer</button>
                  </form>
                ) : null}
                {item.status === 'RESERVED' && item.organisationId ? (
                  <form action={actions.ready as never}>
                    <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="organisationId" value={item.organisationId} />
                    <input name="providerNumberId" placeholder="Verified Sinch provider ID" required /><input name="reason" placeholder="Verification reason" required />
                    <button className="button button--primary" type="submit">Mark ready</button>
                  </form>
                ) : null}
                {item.status === 'RESERVED' || item.status === 'READY' ? (
                  <>
                    <form action={actions.quarantine as never}>
                      <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedStatus" value={item.status} />
                      <input type="datetime-local" name="quarantineUntil" required /><input name="reason" placeholder="Reason" required /><button className="button button--quiet" type="submit">Quarantine</button>
                    </form>
                    <form action={actions.release as never}>
                      <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedStatus" value={item.status} />
                      <input name="reason" placeholder="Reason" required /><label className="platform-confirm"><input type="checkbox" name="confirmation" required />Confirm 30-day cooling</label><button className="button button--danger" type="submit">Release number</button>
                    </form>
                  </>
                ) : null}
                {item.status === 'QUARANTINED' ? (
                  <form action={actions.returnToPool as never}>
                    <input type="hidden" name="numberId" value={item.id} /><input name="reason" placeholder="Reason" required /><label className="platform-confirm"><input type="checkbox" name="confirmation" required />Cooling is complete</label><button className="button button--primary" type="submit">Return to pool</button>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
