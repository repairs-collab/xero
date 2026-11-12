import { and, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { authorise } from '@bc5000/auth';
import {
  auditEvents,
  providerConnections,
  xeroConnections
} from '@bc5000/db/web';

import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import { disconnectXero, requestXeroSync } from './actions.js';

export default async function IntegrationsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (!organisationId) throw new Error('No active organisation membership');
  authorise(session, 'provider.configure', organisationId);

  const database = getDatabaseClient().db;
  const [[legacyConnection], [xeroOAuthConnection], tests] = await Promise.all([
    database
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.organisationId, organisationId),
          eq(providerConnections.provider, 'XERO')
        )
      )
      .limit(1),
    database
      .select()
      .from(xeroConnections)
      .where(eq(xeroConnections.organisationId, organisationId))
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
  const connected =
    xeroOAuthConnection?.status === 'CONNECTED' ||
    legacyConnection?.enabled === true;

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
              <h2>Xero customer connection</h2>
              <p>
                {xeroOAuthConnection?.status ??
                  (legacyConnection?.enabled
                    ? 'Legacy Custom Connection'
                    : 'Not connected')}
              </p>
            </div>
            <span className={`status-dot ${connected ? 'status-dot--ok' : ''}`} />
          </div>
          <dl>
            <div>
              <dt>Connection type</dt>
              <dd>
                {xeroOAuthConnection
                  ? 'Customer OAuth'
                  : legacyConnection?.enabled
                    ? 'Legacy Custom Connection'
                    : 'Not connected'}
              </dd>
            </div>
            <div>
              <dt>Required permissions</dt>
              <dd>
                {xeroOAuthConnection?.status === 'CONNECTED'
                  ? 'Granted'
                  : scopeCount === 3
                    ? 'Legacy verified'
                    : 'Awaiting connection'}
              </dd>
            </div>
          </dl>
          {xeroOAuthConnection?.status === 'CONNECTED' ? (
            <div className="settings-form">
              <a
                className="button button--primary"
                href={`/xero/connect?organisationId=${encodeURIComponent(organisationId)}&returnTo=%2Fsettings%2Fintegrations`}
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
              href={`/xero/connect?organisationId=${encodeURIComponent(organisationId)}&returnTo=%2Fsettings%2Fintegrations`}
            >
              Connect Xero
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
