import { and, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { authorise } from '@bc5000/auth';
import {
  auditEvents,
  providerConnections,
  webhookEvents
} from '@bc5000/db/web';

import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  replaceSecretReference,
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
          Only AWS secret references are shown or accepted. Credentials never
          enter the web application.
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
                      ? 'Xero Custom Connection'
                      : 'Sinch Engage APAC'}
                  </h2>
                  <p>{connection?.enabled ? 'Configured' : 'Not configured'}</p>
                </div>
                <span
                  className={`status-dot ${connection?.lastSuccessfulAuthenticationAt ? 'status-dot--ok' : ''}`}
                />
              </div>
              <dl>
                <div>
                  <dt>Secret reference</dt>
                  <dd>{connection ? suffix(connection.secretArn) : 'Not set'}</dd>
                </div>
                <div>
                  <dt>Last authentication</dt>
                  <dd>
                    {connection?.lastSuccessfulAuthenticationAt
                      ? dateTime(connection.lastSuccessfulAuthenticationAt)
                      : 'Never'}
                  </dd>
                </div>
                {provider === 'XERO' ? (
                  <div>
                    <dt>Required scopes</dt>
                    <dd>{scopeCount === 3 ? 'Verified' : 'Awaiting test'}</dd>
                  </div>
                ) : (
                  <>
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
            </article>
          );
        })}
      </div>
    </div>
  );
}
