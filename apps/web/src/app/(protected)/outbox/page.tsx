import { authorise } from '@bc5000/auth';
import type { OutboundSource, OutboundStatus } from '@bc5000/db/web';
import { PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { headers } from 'next/headers';
import Link from 'next/link';

import { OutboxTable } from '../../../components/outbox-table.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import {
  queryOutbox,
  type OutboxChannel
} from './outbox-query.js';

type SearchParameters = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const channels = new Set<OutboxChannel>(['SMS', 'XERO_EMAIL']);
const sources = new Set<OutboundSource>([
  'AUTOMATED_REMINDER',
  'MANUAL_REMINDER',
  'ESCALATION_SMS',
  'INBOX_REPLY',
  'TEST_SMS',
  'XERO_EMAIL'
]);
const statuses = new Set<OutboundStatus>([
  'PENDING',
  'QUEUED',
  'SENDING',
  'DRY_RUN',
  'ACCEPTED',
  'DELIVERED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED'
]);

const accepted = <Value extends string>(
  value: string | undefined,
  allowed: Set<Value>
): Value | undefined =>
  value !== undefined && allowed.has(value as Value)
    ? (value as Value)
    : undefined;

const dateAt = (value: string | undefined, endOfDay = false): Date | undefined => {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const paginationHref = (
  parameters: SearchParameters,
  cursor: string
): string => {
  const query = new URLSearchParams();
  for (const key of ['search', 'channel', 'source', 'status', 'from', 'to']) {
    const value = first(parameters[key]);
    if (value !== undefined && value !== '') query.set(key, value);
  }
  query.set('cursor', cursor);
  return `/outbox?${query.toString()}`;
};

export default async function OutboxPage({
  searchParams
}: {
  searchParams: Promise<SearchParameters>;
}) {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  authorise(session, 'outbox.read', organisationId);
  const parameters = await searchParams;
  const search = first(parameters.search);
  const channel = accepted(first(parameters.channel), channels);
  const source = accepted(first(parameters.source), sources);
  const status = accepted(first(parameters.status), statuses);
  const from = first(parameters.from);
  const to = first(parameters.to);
  const cursor = first(parameters.cursor);
  const result = await queryOutbox(getDatabaseClient().db, {
    organisationId,
    limit: 25,
    ...(search?.trim() ? { search } : {}),
    ...(channel === undefined ? {} : { channel }),
    ...(source === undefined ? {} : { source }),
    ...(status === undefined ? {} : { status }),
    ...(dateAt(from) === undefined ? {} : { from: dateAt(from)! }),
    ...(dateAt(to, true) === undefined ? {} : { to: dateAt(to, true)! }),
    ...(cursor === undefined ? {} : { cursor })
  });

  return (
    <div className="page-stack">
      <header className="page-heading page-heading--split">
        <div>
          <span className="eyebrow">Outgoing activity</span>
          <h1>Outbox</h1>
          <p>See every reminder, reply, test and Xero email request in one place.</p>
        </div>
        <span className="page-heading__icon" aria-hidden="true">
          <PaperAirplaneIcon />
        </span>
      </header>

      <form className="filter-bar outbox-filters" method="get" aria-label="Outbox filters">
        <label>
          Search
          <input
            name="search"
            type="search"
            placeholder="Client, invoice or recipient"
            defaultValue={search}
          />
        </label>
        <label>
          Channel
          <select name="channel" defaultValue={channel ?? ''}>
            <option value="">All channels</option>
            <option value="SMS">SMS</option>
            <option value="XERO_EMAIL">Xero email</option>
          </select>
        </label>
        <label>
          Source
          <select name="source" defaultValue={source ?? ''}>
            <option value="">All sources</option>
            <option value="AUTOMATED_REMINDER">Automated reminder</option>
            <option value="MANUAL_REMINDER">Manual reminder</option>
            <option value="ESCALATION_SMS">Escalation SMS</option>
            <option value="INBOX_REPLY">Inbox reply</option>
            <option value="TEST_SMS">Test SMS</option>
            <option value="XERO_EMAIL">Xero email</option>
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={status ?? ''}>
            <option value="">All statuses</option>
            {[...statuses].map((value) => (
              <option value={value} key={value}>{value.replaceAll('_', ' ')}</option>
            ))}
          </select>
        </label>
        <label>
          From
          <input name="from" type="date" defaultValue={from} />
        </label>
        <label>
          To
          <input name="to" type="date" defaultValue={to} />
        </label>
        <div className="filter-actions">
          <button className="button button--primary" type="submit">Apply filters</button>
          <Link className="button" href="/outbox">Clear</Link>
        </div>
      </form>

      <OutboxTable rows={result.rows} />
      {result.nextCursor !== null && (
        <div className="outbox-pagination">
          <Link className="button" href={paginationHref(parameters, result.nextCursor)}>
            Next page
          </Link>
        </div>
      )}
    </div>
  );
}
