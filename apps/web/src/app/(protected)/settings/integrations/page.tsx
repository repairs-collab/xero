import { and, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { authorise } from '@bc5000/auth';
import {
  auditEvents,
  providerConnections,
  webhookEvents,
  xeroConnections
} from '@bc5000/db/web';

import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  disconnectXero,
  replaceSecretReference,
  requestXeroSync,
  rotateCallbackKeyReference,
  testConnection
} from './actions.js';

const suffix = (value: string) => `…${value.slice(-18)}`;
const dateTime = (value: Date) =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(value);

export default async function IntegrationsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (!organisationId) throw new Error('No active organisation membership');
  authorise(session, 'provider.configure', organisationId);

  const database = getDatabaseClient().db;
  const connections = await database
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.organisationId, organisationId));
  const [xeroOAuthConnection] = await database
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.organisationId, organisationId))
    .limit(1);
  const [webhook] = await database
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.organisationId, organisationId),
        eq(webhookEvents.signatureValid, true)
      )
    )
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(1);
  const tests = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organisationId, organisationId),
        eq(auditEvents.eventType, 'PROVIDER_CONNECTION_TESTED')
      )
    )
    .orderBy(desc(auditEvents.occurredAt));

  return (
    <div className="page-stack">
      <a className="back-link" href="/settings">← Admin settings</a>
      <header className="page-heading">
        <span className="eyebrow">Provider configuration</span>
        <h1>Integrations</h1>
        <p>
          Connect Xero through secure customer authorisation. Provider
          credentials and refresh tokens are never shown in the browser.
        </p>
      </header>
      <div className="integration-grid">
        {(['XERO', 'SINCH'] as const).map((provider) => {
          const connection = connections.find(
            (item) => item.provider === provider
          );
          const latestTest = tests.find(
            (event) => event.afterValue?.provider === provider
          );
          const scopeCount = Array.isArray(
            latestTest?.afterValue?.requiredScopes
          )
            ? latestTest.afterValue.requiredScopes.length
            : 0;
          return (
            <article className="panel integration-card" key={provider}>
              <div className="integration-title">
                <span
                  className={`provider-logo provider-logo--${provider.toLowerCase()}`}
                >
                  {provider === 'XERO' ? 'X' : 'S'}
                </span>
                <div>
                  <h2>
                    {provider === 'XERO'
                      ? 'Xero customer connection'
                      : 'Sinch Engage APAC'}
                  </h2>
                  <p>
                    {provider === 'XERO'
                      ? xeroOAuthConnection?.status ??
                        (connection?.enabled
                          ? 'Legacy Custom Connection'
                          : 'Not connected')
                      : connection?.enabled
                        ? 'Configured'
                        : 'Not configured'}
                  </p>
                </div>
                <span
                  className={`status-dot ${provider === 'XERO' ? xeroOAuthConnection?.status === 'CONNECTED' || connection?.enabled ? 'status-dot--ok' : '' : connection?.lastSuccessfulAuthenticationAt ? 'status-dot--ok' : ''}`}
                />
              </div>
              <dl>
                {provider === 'XERO' ? (
                  <>
                    <div>
                      <dt>Connection type</dt>
                      <dd>
                        {xeroOAuthConnection
                          ? 'Customer OAuth'
                          : connection?.enabled
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
                  </>
                ) : (
                  <>
                    <div>
                      <dt>Secret reference</dt>
                      <dd>
                        {connection ? suffix(connection.secretArn) : 'Not set'}
                      </dd>
                    </div>
                    <div>
                      <dt>Last authentication</dt>
                      <dd>
                        {connection?.lastSuccessfulAuthenticationAt
                          ? dateTime(connection.lastSuccessfulAuthenticationAt)
                          : 'Never'}
                      </dd>
                    </div>
                    <div>
                      <dt>Region</dt>
                      <dd>{connection?.region ?? 'APAC'}</dd>
                    </div>
                    <div>
                      <dt>Callback key</dt>
                      <dd>{connection?.callbackKeyId ?? 'Not set'}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Webhook health</dt>
                  <dd>
                    {webhook
                      ? `Last valid ${dateTime(webhook.receivedAt)}`
                      : 'No valid webhook yet'}
                  </dd>
                </div>
              </dl>
              {provider === 'SINCH' ? (
                <form className="settings-form" action={replaceSecretReference}>
                  <input
                    type="hidden"
                    name="organisationId"
                    value={organisationId}
                  />
                  <input type="hidden" name="provider" value={provider} />
                  <label>
                    Replace AWS Secrets Manager ARN
                    <input
                      name="secretArn"
                      placeholder="arn:aws:secretsmanager:ap-southeast-2:…"
                      required
                    />
                  </label>
                  <button className="button">Update reference</button>
                </form>
              ) : xeroOAuthConnection?.status === 'CONNECTED' ? (
                <div className="settings-form">
                  <a
                    className="button button--primary"
                    href={`/xero/connect?organisationId=${encodeURIComponent(organisationId)}&returnTo=%2Fsettings%2Fintegrations`}
                  >
                    Reconnect Xero
                  </a>
                  <form action={disconnectXero}>
                    <input
                      type="hidden"
                      name="organisationId"
                      value={organisationId}
                    />
                    <button className="button" type="submit">
                      Disconnect Xero
                    </button>
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
              {provider === 'SINCH' && (
                <form
                  className="settings-form"
                  action={rotateCallbackKeyReference}
                >
                  <input
                    type="hidden"
                    name="organisationId"
                    value={organisationId}
                  />
                  <label>
                    Callback public-key reference
                    <input
                      name="keyId"
                      placeholder="rsa-key-2026-09"
                      required
                    />
                  </label>
                  <button className="button">Rotate key reference</button>
                </form>
              )}
              {provider === 'SINCH' && (
                <form action={testConnection}>
                  <input
                    type="hidden"
                    name="organisationId"
                    value={organisationId}
                  />
                  <input type="hidden" name="provider" value={provider} />
                  <button className="button button--primary">
                    Test connection
                  </button>
                </form>
              )}
              {provider === 'XERO' &&
                (xeroOAuthConnection?.status === 'CONNECTED' ||
                  connection?.enabled) && (
                <form className="settings-form" action={requestXeroSync}>
                  <input
                    type="hidden"
                    name="organisationId"
                    value={organisationId}
                  />
                  <p>
                    Import current receivables from Xero. This never sends a
                    reminder.
                  </p>
                  <button className="button button--primary">
                    Sync Xero now
                  </button>
                </form>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
