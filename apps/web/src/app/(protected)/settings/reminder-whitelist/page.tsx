import { authorise } from '@bc5000/auth';
import { headers } from 'next/headers';

import {
  buildReminderWhitelistSections,
  ReminderWhitelistSettingsList
} from '../../../../components/reminder-whitelist-controls.js';
import { getJobQueue } from '../../../../server/job-runtime.js';
import { createReminderWhitelistService } from '../../../../server/reminder-whitelist-service.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import { removeWhitelistEntry } from './actions.js';

type SearchParameters = Promise<
  Record<string, string | string[] | undefined>
>;

export default async function ReminderWhitelistPage({
  searchParams
}: {
  searchParams: SearchParameters;
}) {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  authorise(session, 'reminder-whitelist.remove', organisationId);
  const parameters = await searchParams;
  const rawSearch = parameters.search;
  const search = (
    Array.isArray(rawSearch) ? rawSearch[0] : rawSearch
  ) ?? '';
  const service = createReminderWhitelistService({
    database: getDatabaseClient().db,
    publisher: await getJobQueue(),
    clock: { now: () => new Date() }
  });
  const rows = await service.list(session, { organisationId });
  const sections = buildReminderWhitelistSections(rows, search);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">Sending exclusions</span>
        <h1>Reminder Whitelist</h1>
        <p>
          Manage clients and invoices that AccountPulse must exclude from
          reminder chasing.
        </p>
      </header>
      <form className="filter-bar whitelist-search" method="get">
        <label>
          Search active entries
          <input
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Client, invoice, reason or creator"
          />
        </label>
        <button className="button button--primary" type="submit">Search</button>
      </form>
      <aside className="sending-banner">
        Removing an entry can make eligible invoices resume chasing immediately.
        AccountPulse creates fresh work; old approvals are never reused.
      </aside>
      <ReminderWhitelistSettingsList
        organisationId={organisationId}
        sections={sections}
        removeAction={removeWhitelistEntry}
      />
    </div>
  );
}
