import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { authorise } from '@bc5000/auth';
import {
  organisations,
  providerConnections
} from '@bc5000/db/web';

import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import { activateLive, disableLive, updateAllowlist } from './actions.js';
import {
  liveActivationFeedback,
  LIVE_ACKNOWLEDGEMENT
} from './sending-settings.js';

type SearchParameters = Promise<
  Record<string, string | string[] | undefined>
>;

export default async function SendingSettingsPage({
  searchParams
}: {
  searchParams: SearchParameters;
}) {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (!organisationId) throw new Error('No active organisation membership');
  authorise(session, 'provider.configure', organisationId);

  const database = getDatabaseClient().db;
  const [organisation] = await database
    .select()
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (!organisation) throw new Error('Organisation not found');

  const providers = await database
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.organisationId, organisationId));
  const parameters = await searchParams;
  const activationFeedback = liveActivationFeedback(parameters.activation);

  const now = Date.now();
  const healthySince = now - 24 * 60 * 60 * 1000;
  const providerHealthy = (provider: 'XERO' | 'SINCH') =>
    providers.some(
      (connection) =>
        connection.provider === provider &&
        connection.enabled &&
        connection.connectedAt !== null &&
        connection.lastSuccessfulAuthenticationAt !== null &&
        connection.lastSuccessfulAuthenticationAt.getTime() >= healthySince
    );
  const fresh =
    organisation.lastSuccessfulSyncAt !== null &&
    now - organisation.lastSuccessfulSyncAt.getTime() <= 15 * 60_000;

  return (
    <div className="page-stack">
      <a className="back-link" href="/settings">← Admin settings</a>
      <header className="page-heading">
        <span className="eyebrow">Delivery safety</span>
        <h1>Sending controls</h1>
        <p>
          AccountPulse starts in dry-run. Live mode is deliberately difficult
          to enable.
        </p>
      </header>
      {activationFeedback !== null && (
        <div
          className={`sending-feedback sending-feedback--${activationFeedback.tone}`}
          role={activationFeedback.tone === 'error' ? 'alert' : 'status'}
        >
          <strong>{activationFeedback.title}</strong>
          <p>{activationFeedback.detail}</p>
        </div>
      )}
      <section
        className={`sending-banner sending-banner--${organisation.sendMode}`}
      >
        <div>
          <span className="eyebrow">Current mode</span>
          <h2>
            {organisation.sendMode === 'live'
              ? 'Live sending'
              : 'Dry-run only'}
          </h2>
          <p>
            {organisation.sendMode === 'live'
              ? 'Eligible allowlisted messages can reach providers.'
              : 'Previews and outbound records are created, but providers are not called.'}
          </p>
        </div>
        <span>{organisation.sendMode === 'live' ? 'LIVE' : 'SAFE'}</span>
      </section>
      <div className="settings-grid">
        <section className="panel">
          <span className="eyebrow">Recipient allowlist</span>
          <h2>Controlled destinations</h2>
          <p className="settings-copy">
            Only phone numbers and email addresses on this list can receive
            live reminders during launch.
          </p>
          <form className="settings-form" action={updateAllowlist}>
            <input
              type="hidden"
              name="organisationId"
              value={organisationId}
            />
            <label>
              Mobile numbers or email addresses
              <textarea
                name="recipients"
                rows={6}
                defaultValue={organisation.recipientAllowlist.join('\n')}
                placeholder={'0400 000 001\naccounts@example.com'}
              />
            </label>
            <button className="button button--primary">Save allowlist</button>
          </form>
        </section>
        <section className="panel">
          <span className="eyebrow">Live-mode gates</span>
          <h2>Controlled launch readiness</h2>
          <ul className="gate-list">
            <li className={providerHealthy('XERO') ? 'passed' : ''}>
              Xero connection healthy in the last 24 hours
            </li>
            <li className={providerHealthy('SINCH') ? 'passed' : ''}>
              Sinch connection healthy in the last 24 hours
            </li>
            <li className={fresh ? 'passed' : ''}>
              Xero sync within 15 minutes
            </li>
            <li
              className={
                organisation.recipientAllowlist.length ? 'passed' : ''
              }
            >
              Controlled allowlist configured
            </li>
          </ul>
          {organisation.sendMode === 'dry-run' ? (
            <form className="settings-form" action={activateLive}>
              <input
                type="hidden"
                name="organisationId"
                value={organisationId}
              />
              <label>
                Type the exact acknowledgement
                <input
                  name="acknowledgement"
                  autoComplete="off"
                  placeholder={LIVE_ACKNOWLEDGEMENT}
                />
              </label>
              <button className="button button--danger">
                Enable controlled live testing
              </button>
              <p className="settings-copy">
                Only destinations on the technical recipient allowlist can
                receive messages. Complete controlled SMS and Xero email tests
                before the final customer rollout.
              </p>
            </form>
          ) : (
            <form className="settings-form" action={disableLive}>
              <input
                type="hidden"
                name="organisationId"
                value={organisationId}
              />
              <label>
                Reason for returning to dry-run
                <input name="reason" required />
              </label>
              <button className="button button--danger">
                Disable live sending
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
