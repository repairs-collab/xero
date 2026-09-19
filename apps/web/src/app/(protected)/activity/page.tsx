import { headers } from 'next/headers';

import { PostgresActivityRepository } from '@bc5000/db/web';

import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

const validDate = (value: string | undefined, end = false) => { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined; return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`); };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string,string | string[] | undefined>> }) {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); const organisationId = session.memberships[0]?.organisationId; if (!organisationId) throw new Error('No active organisation membership'); const params = await searchParams; const text = (name:string) => typeof params[name] === 'string' ? params[name] : undefined;
  const query = text('q'); const eventType = text('eventType'); const from = validDate(text('from')); const to = validDate(text('to'), true);
  const rows = await new PostgresActivityRepository(getDatabaseClient().db).search(organisationId, { ...(query ? { query } : {}), ...(eventType ? { eventType } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">Immutable audit trail</span><h1>Activity</h1><p>Search customer, invoice, user, provider message, task, correlation ID, or event type.</p></header><form className="filter-bar activity-filters"><label>Search<input name="q" type="search" defaultValue={text('q')} placeholder="Customer, invoice, message…"/></label><label>Event type<input name="eventType" defaultValue={text('eventType')} placeholder="e.g. REMINDER_APPROVED"/></label><label>From (UTC)<input name="from" type="date" defaultValue={text('from')}/></label><label>To (UTC)<input name="to" type="date" defaultValue={text('to')}/></label><button className="button button--primary">Apply filters</button></form><div className="activity-table"><div className="activity-row activity-row--header"><span>Time</span><span>Event</span><span>Entity</span><span>Correlation</span></div>{rows.map((event) => <div className="activity-row" key={event.id}><time>{new Intl.DateTimeFormat('en-AU',{dateStyle:'medium',timeStyle:'short',timeZone:'Australia/Sydney'}).format(event.occurredAt)}</time><span><strong>{event.eventType}</strong><small>{event.actorUserId ? 'User action' : 'System'}</small></span><span>{event.entityType}<small>{event.entityId}</small></span><code>{event.correlationId ?? '—'}</code></div>)}</div></div>;
}
