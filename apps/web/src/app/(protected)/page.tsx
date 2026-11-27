import { headers } from 'next/headers';

import { DashboardRepository } from '@bc5000/db/web';

import { DashboardView } from '../../components/dashboard-view.js';
import { getDatabaseClient, requireWebSession } from '../../server/runtime.js';
import { legalIdentity } from '../../server/legal-content.js';
import { formatLastXeroSync, getXeroSyncHealth } from '../../server/xero-sync-health.js';

const money = (amount: string, currency: string) => new Intl.NumberFormat('en-AU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(amount));

export default async function OverviewPage() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) throw new Error('No active organisation membership');
  const now = new Date();
  const snapshot = await new DashboardRepository(getDatabaseClient().db).snapshot(
    organisationId,
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(now)
  );
  const xeroSyncHealth = getXeroSyncHealth(
    {
      edition: snapshot.edition,
      oauthStatus: snapshot.xeroOAuthStatus,
      legacyEnabled: snapshot.legacyXeroEnabled,
      lastSuccessfulSyncAt: snapshot.lastXeroSync
    },
    new Date()
  );
  const support = legalIdentity();
  return (
    <DashboardView model={{
      ...snapshot,
      overdueTotal: money(snapshot.overdueTotal, snapshot.baseCurrency),
      paidAfterReminders: money(snapshot.paidAfterReminders, snapshot.baseCurrency),
      lastXeroSync: formatLastXeroSync(snapshot.lastXeroSync, snapshot.timeZone),
      xeroSyncHealth,
      supportEmail: support.supportEmail,
      supportChatUrl: support.supportChatUrl
    }} />
  );
}
