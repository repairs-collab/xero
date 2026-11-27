import { and, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { authorise } from '@bc5000/auth';
import {
  auditEvents,
  organisations,
  providerConnections,
  xeroConnections
} from '@bc5000/db/web';

import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  formatLastXeroSync,
  getXeroSyncHealth,
  usesLegacyXeroConnection,
  xeroSyncHealthCopy
} from '../../../../server/xero-sync-health.js';
import { disconnectXero, requestXeroSync } from './actions.js';

export default async function IntegrationsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (!organisationId) throw new Error('No active organisation membership');
  authorise(session, 'provider.configure', organisationId);

  const database = getDatabaseClient().db;
  const [[legacyConnection], [organisation], tests] = await Promise.all([
    database
      .select({ enabled: providerConnections.enabled })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.organisationId, organisationId),
          eq(providerConnections.provider, 'XERO')
        )
      )
      .limit(1),
    database
      .select({
        edition: organisations.edition,
        lastSuccessfulSyncAt: organisations.lastSuccessfulSyncAt,
        timeZone: organisations.timeZone,
        oauthStatus: xeroConnections.status
      })
      .from(organisations)
      .leftJoin(xeroConnections, eq(xeroConnections.organisationId, organisations.id))
      .where(eq(organisations.id, organisationId))
      .limit(1),
    database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, organisationId),
          eq(auditEvents.eventType, 'PROVIDER_CONNECTION_TESTED')
        )
      )
      .orderBy(desc(auditEvents.occurredAt))
  ]);
  const latestXeroTest = tests.find(
    (event) => event.afterValue?.provider === 'XERO'
  );
  const scopeCount = Array.isArray(latestXeroTest?.afterValue?.requiredScopes)
    ? latestXeroTest.afterValue.requiredScopes.length
    : 0;
  if (!organisation) throw new Error('No active organisation');
  const { oauthStatus, lastSuccessfulSyncAt, timeZone } = organisation;
  const xeroState = {
    edition: organisation.edition,
    oauthStatus,
    legacyEnabled: legacyConnection?.enabled === true
  };
  const legacyEnabled = usesLegacyXeroConnection(xeroState);
  const xeroSyncHealth = getXeroSyncHealth(
    {
      ...xeroState,
      lastSuccessfulSyncAt
    },
    new Date()
  );
  const connected = oauthStatus === 'CONNECTED' || legacyEnabled;
  const connectUrl = `/xero/connect?organisationId=${encodeURIComponent(organisationId)}&returnTo=%2Fsettings%2Fintegrations`;

  return (
    <div className="page-stack">
      <a className="back-link" href="/settings">← Admin settings</a>
      <header className="page-heading">
        <span className="eyebrow">Accounting connection</span>
        <h1>Xero connection</h1>
        <p>
          Connect and sync your Xero organisation through secure customer
          authorisation. AccountPulse never shows refresh tokens in the browser.
        </p>
      </header>
      <div className="integration-grid">
        <article className="panel integration-card">
          <div className="integration-title">
            <span className="provider-logo provider-logo--xero">X</span>
            <div>
              <h2>{xeroSyncHealthCopy[xeroSyncHealth].label}</h2>
            </div>
            <span
              aria-hidden="true"
              className={`status-dot${xeroSyncHealth === 'CURRENT' ? ' status-dot--ok' : ''}`}
            />
          </div>
          <dl>
            <div>
              <dt>Connection type</dt>
              <dd>
                {legacyEnabled
                  ? 'Legacy Custom Connection'
                  : oauthStatus !== null && oauthStatus !== 'DISCONNECTED'
                    ? 'Customer OAuth'
                    : 'Not connected'}
              </dd>
            </div>
            <div>
              <dt>Required permissions</dt>
              <dd>
                {oauthStatus === 'CONNECTED'
                  ? 'Granted'
                  : oauthStatus === 'REAUTH_REQUIRED'
                    ? 'Reconnection required'
                    : legacyEnabled && scopeCount === 3
                      ? 'Legacy verified'
                      : legacyEnabled
                        ? 'Awaiting verification'
                        : 'Awaiting connection'}
              </dd>
            </div>
            <div>
              <dt>Last successful sync</dt>
              <dd>
                {lastSuccessfulSyncAt === null ? (
                  'No successful sync recorded'
                ) : (
                  <time dateTime={lastSuccessfulSyncAt.toISOString()}>
                    {formatLastXeroSync(lastSuccessfulSyncAt, timeZone)}
                  </time>
                )}
              </dd>
            </div>
          </dl>
          {xeroSyncHealth === 'DELAYED' && (
            <p className="settings-copy">Invoices and payments may be out of date.</p>
          )}
          {oauthStatus === 'CONNECTED' ? (
            <div className="settings-form">
              <a
                className="button button--primary"
                href={connectUrl}
              >
                Reconnect Xero
              </a>
              <form action={disconnectXero}>
                <input type="hidden" name="organisationId" value={organisationId} />
                <button className="button" type="submit">Disconnect Xero</button>
              </form>
            </div>
          ) : (
            <a
              className="button button--primary"
              href={connectUrl}
            >
              {oauthStatus === 'REAUTH_REQUIRED' ? 'Reconnect Xero' : 'Connect Xero'}
            </a>
          )}
          {connected && (
            <form className="settings-form" action={requestXeroSync}>
              <input type="hidden" name="organisationId" value={organisationId} />
              <p>Import current receivables from Xero. This never sends a reminder.</p>
              <button className="button button--primary">Sync Xero now</button>
            </form>
          )}
        </article>
      </div>
    </div>
  );
}
