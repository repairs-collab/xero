import { headers } from 'next/headers';

import {
  CUSTOMER_ACTIVITY_FILTER_OPTIONS,
  isCustomerActivityType,
  PostgresActivityRepository
} from '@bc5000/db/web';

import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

const validDate = (value: string | undefined, end = false) => { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined; return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`); };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string,string | string[] | undefined>> }) {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); const organisationId = session.memberships[0]?.organisationId; if (!organisationId) throw new Error('No active organisation membership'); const params = await searchParams; const text = (name:string) => typeof params[name] === 'string' ? params[name] : undefined;
  const query = text('q'); const requestedActivityType = text('eventType'); const activityType = isCustomerActivityType(requestedActivityType) ? requestedActivityType : undefined; const from = validDate(text('from')); const to = validDate(text('to'), true);
  const rows = await new PostgresActivityRepository(getDatabaseClient().db).searchCustomerActivity(organisationId, { ...(query ? { query } : {}), ...(activityType ? { activityType } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">Account activity</span><h1>Activity</h1><p>Review customer, reminder, user, voice and Xero activity recorded by AccountPulse.</p></header><form className="filter-bar activity-filters"><label>Search<input name="q" type="search" defaultValue={query} placeholder="Customer, invoice, message…"/></label><label>Activity type<select name="eventType" defaultValue={activityType ?? ''}><option value="">All activity</option>{CUSTOMER_ACTIVITY_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>From (UTC)<input name="from" type="date" defaultValue={text('from')}/></label><label>To (UTC)<input name="to" type="date" defaultValue={text('to')}/></label><button className="button button--primary">Apply filters</button></form><div className="activity-table"><div className="activity-row activity-row--header"><span>Time</span><span>Activity</span><span>Subject</span><span>Source</span></div>{rows.map((event) => <div className="activity-row" key={event.id}><time>{new Intl.DateTimeFormat('en-AU',{dateStyle:'medium',timeStyle:'short',timeZone:'Australia/Sydney'}).format(event.occurredAt)}</time><span><strong>{event.label}</strong></span><span>{event.subject}</span><span>{event.actorLabel}</span></div>)}</div></div>;
}
