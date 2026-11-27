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
  getOnboardingService,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  acknowledgeReconciliation,
  activateCustomerRollout,
  activateLive,
  disableAllProviderSending,
  overrideCustomerRollout,
  returnToControlledLive,
  updateAllowlist
} from './actions.js';
import {
  CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT,
  CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT,
  getCustomerRolloutReadiness,
  liveActivationFeedback,
  LIVE_ACKNOWLEDGEMENT,
  RECONCILIATION_ACKNOWLEDGEMENT,
  type ReconciliationMetrics
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

function ReconcileXeroForm({
  organisationId,
  version,
  syncId,
  syncCompletedAt,
  metrics,
  legacy = false
}: {
  organisationId: string;
  version: number;
  syncId: string | null;
  syncCompletedAt: Date | null;
  metrics: ReconciliationMetrics;
  legacy?: boolean;
}) {
  return (
    <form className="settings-form" action={acknowledgeReconciliation}>
      <HiddenOrganisationState organisationId={organisationId} version={version} />
      {Object.entries({
        syncId: syncId ?? '',
        syncCompletedAt: syncCompletedAt?.toISOString() ?? '',
        activeContactCount: metrics.activeContactCount,
        outstandingInvoiceCount: metrics.outstandingInvoiceCount,
        outstandingTotals: JSON.stringify(metrics.outstandingTotals),
        generatedApprovalCount: metrics.generatedApprovalCount,
        enabledSequenceCount: metrics.enabledSequenceCount,
        allEnabledSequencesReview: String(metrics.allEnabledSequencesReview)
      }).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {legacy && (
        <label>
          Type the exact reconciliation acknowledgement
          <input name="acknowledgement" autoComplete="off"
            placeholder={RECONCILIATION_ACKNOWLEDGEMENT} required />
        </label>
      )}
      <button className="button button--primary">
        {legacy ? 'Record reconciliation' : 'Figures match Xero'}
      </button>
    </form>
  );
}

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
  const onboarding =
    organisation.edition === 'SOLO'
      ? await getOnboardingService().getStatus(session, organisationId)
      : null;
  const readiness = await getCustomerRolloutReadiness(database, {
    organisationId,
    now
  });
  const parameters = await searchParams;
  const reconcile = organisation.operationalState === 'RECONCILIATION_REQUIRED' &&
    organisation.lastSuccessfulSyncAt !== null && organisation.lastSuccessfulSyncId !== null;
  const renderReconciliationForm = (legacy = false) => (
    <ReconcileXeroForm
      organisationId={organisationId}
      version={organisation.operationalStateVersion}
      syncId={organisation.lastSuccessfulSyncId}
      syncCompletedAt={organisation.lastSuccessfulSyncAt}
      metrics={readiness.metrics}
      legacy={legacy}
    />
  );
  if (onboarding !== null) {
    const active = organisation.sendMode === 'live' && organisation.rolloutScope === 'CUSTOMER';
    const canEnable = !active && onboarding.complete && readiness.readyForCustomerAcknowledgement;
    const feedback = rolloutFeedback(firstParameter(parameters.rollout), {
      sendMode: organisation.sendMode,
      rolloutScope: organisation.rolloutScope,
      operationalState: organisation.operationalState,
      reconciliationCurrent: readiness.gates.reconciliationCurrent.passed
    });
    const showReconciliation = reconcile && readiness.gates.syncFresh.passed &&
      readiness.gates.resetIdle.passed;
    const needsSync = !readiness.gates.syncFresh.passed ||
      (!showReconciliation && !readiness.gates.reconciliationCurrent.passed);
    return (
      <div className="page-stack sending-controls-page">
        <a className="back-link" href="/settings">← Settings</a>
        <header className="page-heading">
          <h1>Customer sending</h1>
          <p>Manage whether AccountPulse can send your reminders.</p>
        </header>
        {feedback?.tone === 'error' && (
          <div className="callout callout--warning" role="alert">
            <strong>{feedback.title}</strong>
            <p>Review your setup and try again.</p>
          </div>
        )}
        <section className="panel rollout-action-panel">
          <h2>{active ? 'Customer sending is enabled' : 'Customer sending is off'}</h2>
          <p>{active
            ? 'Reminders follow the approval and delivery rules in your sequences.'
            : 'AccountPulse skips delivery for reminders processed while sending is off.'}</p>
          {active ? (
            <form className="settings-form" action={disableAllProviderSending}>
              <HiddenOrganisationState organisationId={organisationId}
                version={organisation.operationalStateVersion} />
              <input type="hidden" name="reason" value="Paused from Customer sending" />
              <button className="button button--secondary">Pause sending</button>
            </form>
          ) : canEnable ? (
            <form className="settings-form" action={activateCustomerRollout}>
              <HiddenOrganisationState organisationId={organisationId}
                version={organisation.operationalStateVersion} />
              <button className="button button--primary">Enable customer sending</button>
            </form>
          ) : !showReconciliation && (
            <div className="button-row">
              {needsSync && (
                <a className="button" href="/settings/integrations">Check Xero and sync</a>
              )}
              <a className="button" href="/onboarding">Review setup</a>
            </div>
          )}
          {active && needsSync && (
            <a className="button" href="/settings/integrations">Check Xero and sync</a>
          )}
        </section>
        {showReconciliation && (
          <>
            <ReconciliationSummary metrics={readiness.metrics}
              syncCompletedAt={organisation.lastSuccessfulSyncAt} reconciliationCurrent={false} />
            <section className="panel rollout-action-panel">
              <h2>Confirm the invoice totals</h2>
              <p>Compare these figures with your latest receivables in Xero.</p>
              {renderReconciliationForm()}
            </section>
          </>
        )}
      </div>
    );
  }
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
  const canRequestCustomerRollout =
    organisation.sendMode === 'live' &&
    organisation.rolloutScope === 'CONTROLLED' &&
    organisation.operationalState === 'RECONCILED';
  const canOverrideCustomerRollout =
    organisation.edition === 'INTERNAL_LEGACY' &&
    organisation.rolloutScope === 'CONTROLLED' &&
    organisation.maintenanceMode === false &&
    !['RESET_PREPARING', 'RESET_IN_PROGRESS', 'RESET_FAILED'].includes(
      organisation.operationalState
    );

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
            Customer sending requires a fresh Xero sync, reconciliation, and final
            Administrator approval. The reset workflow must be idle.
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
              ? 'Outbound records may be prepared, but no message is delivered.'
              : mode === 'Controlled live'
                ? 'Message delivery is limited to the technical recipient allowlist.'
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

      {reconcile && (
        <section className="panel rollout-action-panel">
          <span className="eyebrow">Reconciliation approval</span>
          <h2>Confirm these figures match Xero</h2>
          <p className="settings-copy">
            This acknowledgement is tied to the successful sync shown above.
            Another sync will invalidate it.
          </p>
          {renderReconciliationForm(true)}
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

      {canOverrideCustomerRollout && (
        <section className="panel rollout-action-panel rollout-override-panel">
          <span className="eyebrow">Administrator override</span>
          <h2>Override setup checks and enable Customer Live</h2>
          <p className="settings-copy">
            This bypasses rollout setup gates only. It cannot bypass maintenance
            or reset locks, paid-invoice checks, opt-outs, suppressions,
            whitelists, pauses, invalid contact details, duplicate prevention,
            source changes, or sending windows. The audit log records the
            Administrator, that a reason was supplied, and the bypassed setup
            gates; the private reason text is not retained.
          </p>
          <form className="settings-form" action={overrideCustomerRollout}>
            <HiddenOrganisationState
              organisationId={organisationId}
              version={organisation.operationalStateVersion}
            />
            <label>
              Operational reason
              <textarea name="reason" rows={3} maxLength={500} required />
            </label>
            <label>
              Type the exact override confirmation
              <input
                name="acknowledgement"
                autoComplete="off"
                placeholder={CUSTOMER_ROLLOUT_OVERRIDE_ACKNOWLEDGEMENT}
                required
              />
            </label>
            <button className="button button--danger">
              Override setup checks and enable Customer Live
            </button>
          </form>
        </section>
      )}

      <div className="settings-grid rollout-controls-grid">
        <section className="panel">
          <span className="eyebrow">Technical test destinations</span>
          <h2>Controlled testing destinations</h2>
          <p className="settings-copy">
            This list limits AccountPulse delivery in Controlled live and always
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
          <h2>Emergency sending controls</h2>
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
                Reason for disabling all sending
                <input name="reason" maxLength={500} required />
              </label>
              <button className="button button--danger">
                Disable all sending
              </button>
            </form>
          )}
          {organisation.sendMode === 'dry-run' && (
            <p className="settings-copy">
              Message delivery is disabled. Enable Controlled live only after
              the technical allowlist and connection checks are ready.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
