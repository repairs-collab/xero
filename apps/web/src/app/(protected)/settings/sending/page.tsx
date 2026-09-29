import { desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { authorise } from '@bc5000/auth';
import { operationalResetRuns, organisations } from '@bc5000/db/web';

import {
  ReconciliationSummary,
  ResetStatusPanel
} from '../../../../components/reconciliation-summary.js';
import {
  rolloutFeedback,
  rolloutModeLabel,
  RolloutGateList
} from '../../../../components/rollout-gate-list.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  acknowledgeReconciliation,
  activateCustomerRollout,
  activateLive,
  disableAllProviderSending,
  returnToControlledLive,
  updateAllowlist
} from './actions.js';
import {
  CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
  getCustomerRolloutReadiness,
  liveActivationFeedback,
  LIVE_ACKNOWLEDGEMENT,
  RECONCILIATION_ACKNOWLEDGEMENT
} from './sending-settings.js';

type SearchParameters = Promise<
  Record<string, string | string[] | undefined>
>;

const firstParameter = (
  value: string | string[] | undefined
): string | undefined => (Array.isArray(value) ? value[0] : value);

const HiddenOrganisationState = ({
  organisationId,
  version
}: {
  organisationId: string;
  version: number;
}) => (
  <>
    <input type="hidden" name="organisationId" value={organisationId} />
    <input type="hidden" name="expectedVersion" value={version} />
  </>
);

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
  const now = new Date();
  const [organisation] = await database
    .select()
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (!organisation) throw new Error('Organisation not found');
  const readiness = await getCustomerRolloutReadiness(database, {
    organisationId,
    now
  });
  const [latestResetRun] = await database
    .select({
      id: operationalResetRuns.id,
      status: operationalResetRuns.status,
      snapshotIdentifier: operationalResetRuns.snapshotIdentifier,
      snapshotCreatedAt: operationalResetRuns.snapshotCreatedAt,
      completedAt: operationalResetRuns.completedAt
    })
    .from(operationalResetRuns)
    .where(eq(operationalResetRuns.organisationId, organisationId))
    .orderBy(desc(operationalResetRuns.requestedAt))
    .limit(1);
  const parameters = await searchParams;
  const feedback =
    rolloutFeedback(firstParameter(parameters.rollout), {
      sendMode: organisation.sendMode,
      rolloutScope: organisation.rolloutScope,
      operationalState: organisation.operationalState,
      reconciliationCurrent: readiness.gates.reconciliationCurrent.passed
    }) ??
    (organisation.sendMode === 'live' &&
    organisation.rolloutScope === 'CONTROLLED'
      ? liveActivationFeedback(parameters.activation)
      : null);
  const mode = rolloutModeLabel(
    organisation.sendMode,
    organisation.rolloutScope
  );
  const reconciliationCurrent =
    readiness.gates.reconciliationCurrent.passed;
  const canAcknowledgeReconciliation =
    organisation.operationalState === 'RECONCILIATION_REQUIRED' &&
    organisation.lastSuccessfulSyncAt !== null;
  const canRequestCustomerRollout =
    organisation.sendMode === 'live' &&
    organisation.rolloutScope === 'CONTROLLED' &&
    organisation.operationalState === 'RECONCILED';

  return (
    <div className="page-stack sending-controls-page">
      <a className="back-link" href="/settings">
        ← Admin settings
      </a>
      <header className="page-heading page-heading--split">
        <div>
          <span className="eyebrow">Delivery safety</span>
          <h1>Sending controls</h1>
          <p>
            Customer sending opens only after a protected reset, a fresh Xero
            sync, reconciliation, and final Administrator approval.
          </p>
        </div>
        <div className="rollout-state-legend" aria-label="Sending states">
          {(['Dry run', 'Controlled live', 'Customer live'] as const).map(
            (label) => (
              <span className={label === mode ? 'is-current' : ''} key={label}>
                {label}
              </span>
            )
          )}
        </div>
      </header>
      {feedback !== null && (
        <div
          className={`sending-feedback sending-feedback--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          <strong>{feedback.title}</strong>
          <p>{feedback.detail}</p>
        </div>
      )}
      <section
        className={`sending-banner rollout-mode-banner rollout-mode-banner--${organisation.rolloutScope.toLowerCase()}`}
      >
        <div>
          <span className="eyebrow">Current sending state</span>
          <h2>{mode}</h2>
          <p>
            {mode === 'Dry run'
              ? 'Outbound records may be prepared, but no provider call can be made.'
              : mode === 'Controlled live'
                ? 'Provider calls are limited to the technical recipient allowlist.'
                : 'Approved reminders may reach eligible customers, subject to every normal safeguard.'}
          </p>
        </div>
        <span>{mode}</span>
      </section>

      <div className="rollout-layout">
        <section className="panel rollout-gates-panel">
          <RolloutGateList readiness={readiness} />
        </section>
        <ResetStatusPanel
          operationalState={organisation.operationalState}
          resetRun={latestResetRun ?? null}
        />
      </div>

      <ReconciliationSummary
        metrics={readiness.metrics}
        syncCompletedAt={organisation.lastSuccessfulSyncAt}
        reconciliationCurrent={reconciliationCurrent}
      />

      {canAcknowledgeReconciliation && (
        <section className="panel rollout-action-panel">
          <span className="eyebrow">Reconciliation approval</span>
          <h2>Confirm these figures match Xero</h2>
          <p className="settings-copy">
            This acknowledgement is tied to the successful sync shown above.
            Another sync will invalidate it.
          </p>
          <form className="settings-form" action={acknowledgeReconciliation}>
            <HiddenOrganisationState
              organisationId={organisationId}
              version={organisation.operationalStateVersion}
            />
            <input
              type="hidden"
              name="syncCompletedAt"
              value={organisation.lastSuccessfulSyncAt?.toISOString()}
            />
            <input
              type="hidden"
              name="activeContactCount"
              value={readiness.metrics.activeContactCount}
            />
            <input
              type="hidden"
              name="outstandingInvoiceCount"
              value={readiness.metrics.outstandingInvoiceCount}
            />
            <input
              type="hidden"
              name="outstandingTotals"
              value={JSON.stringify(readiness.metrics.outstandingTotals)}
            />
            <input
              type="hidden"
              name="generatedApprovalCount"
              value={readiness.metrics.generatedApprovalCount}
            />
            <input
              type="hidden"
              name="enabledSequenceCount"
              value={readiness.metrics.enabledSequenceCount}
            />
            <input
              type="hidden"
              name="allEnabledSequencesReview"
              value={String(readiness.metrics.allEnabledSequencesReview)}
            />
            <label>
              Type the exact reconciliation acknowledgement
              <input
                name="acknowledgement"
                autoComplete="off"
                placeholder={RECONCILIATION_ACKNOWLEDGEMENT}
                required
              />
            </label>
            <button className="button button--primary">
              Record reconciliation
            </button>
          </form>
        </section>
      )}

      {canRequestCustomerRollout && (
        <section className="panel rollout-action-panel rollout-action-panel--final">
          <span className="eyebrow">Final customer approval</span>
          <h2>Approve customer live sending</h2>
          <p className="settings-copy">
            This is separate from deployment, reset, sync, and reconciliation.
            Every gate is checked again inside the approval transaction.
          </p>
          <form className="settings-form" action={activateCustomerRollout}>
            <HiddenOrganisationState
              organisationId={organisationId}
              version={organisation.operationalStateVersion}
            />
            <label>
              Type the exact customer-rollout acknowledgement
              <input
                name="acknowledgement"
                autoComplete="off"
                placeholder={CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT}
                required
              />
            </label>
            <button
              className="button button--danger"
              disabled={!readiness.readyForCustomerAcknowledgement}
            >
              Enable Customer live
            </button>
          </form>
        </section>
      )}

      <div className="settings-grid rollout-controls-grid">
        <section className="panel">
          <span className="eyebrow">Technical recipient allowlist</span>
          <h2>Controlled testing destinations</h2>
          <p className="settings-copy">
            This list limits provider calls in Controlled live and always
            limits the Test SMS tool. It is not a customer contact list.
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
                required
              />
            </label>
            <button className="button button--primary">Save allowlist</button>
          </form>
        </section>

        <section className="panel">
          <span className="eyebrow">Sending controls</span>
          <h2>Provider-call safety</h2>
          {organisation.sendMode === 'dry-run' && (
            <form className="settings-form" action={activateLive}>
              <HiddenOrganisationState
                organisationId={organisationId}
                version={organisation.operationalStateVersion}
              />
              <label>
                Type the exact controlled-live acknowledgement
                <input
                  name="acknowledgement"
                  autoComplete="off"
                  placeholder={LIVE_ACKNOWLEDGEMENT}
                  required
                />
              </label>
              <button className="button button--danger">
                Enable Controlled live
              </button>
            </form>
          )}
          {organisation.sendMode === 'live' &&
            organisation.rolloutScope === 'CUSTOMER' && (
              <form className="settings-form" action={returnToControlledLive}>
                <HiddenOrganisationState
                  organisationId={organisationId}
                  version={organisation.operationalStateVersion}
                />
                <label>
                  Reason for returning to Controlled live
                  <input name="reason" maxLength={500} required />
                </label>
                <button className="button button--secondary">
                  Return to Controlled live
                </button>
              </form>
            )}
          {organisation.sendMode === 'live' && (
            <form
              className="settings-form emergency-stop-form"
              action={disableAllProviderSending}
            >
              <HiddenOrganisationState
                organisationId={organisationId}
                version={organisation.operationalStateVersion}
              />
              <label>
                Reason for disabling all provider sending
                <input name="reason" maxLength={500} required />
              </label>
              <button className="button button--danger">
                Disable all provider sending
              </button>
            </form>
          )}
          {organisation.sendMode === 'dry-run' && (
            <p className="settings-copy">
              Provider calls are disabled. Enable Controlled live only after
              the technical allowlist and connection checks are ready.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
