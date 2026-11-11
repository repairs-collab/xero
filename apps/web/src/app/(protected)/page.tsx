import { headers } from 'next/headers';

import { DashboardRepository } from '@bc5000/db/web';

import { DashboardView } from '../../components/dashboard-view.js';
import { getDatabaseClient, requireWebSession } from '../../server/runtime.js';
import { legalIdentity } from '../../server/legal-content.js';

const money = (amount: string, currency: string) => new Intl.NumberFormat('en-AU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(amount));

export default async function OverviewPage() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) throw new Error('No active organisation membership');
  const snapshot = await new DashboardRepository(getDatabaseClient().db).snapshot(organisationId, new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date()));
  const organisation = await getDatabaseClient().db.query.organisations.findFirst({ where: (table, { eq }) => eq(table.id, organisationId) });
  const currency = organisation?.baseCurrency ?? 'AUD';
  const support = legalIdentity();
  return <DashboardView model={{ ...snapshot, overdueTotal: money(snapshot.overdueTotal, currency), paidAfterReminders: money(snapshot.paidAfterReminders, currency), lastXeroSync: snapshot.lastXeroSync === null ? 'Not yet synced' : new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney' }).format(snapshot.lastXeroSync), supportEmail: support.supportEmail, supportChatUrl: support.supportChatUrl }} />;
}
