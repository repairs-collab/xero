import type { ReconciliationMetrics } from '../app/(protected)/settings/sending/sending-settings.js';

type ResetRun = {
  id: string;
  status:
    | 'PREPARING'
    | 'SNAPSHOT_CREATED'
    | 'RESETTING'
    | 'COMPLETED'
    | 'FAILED'
    | 'ABORTED';
  snapshotIdentifier: string | null;
  snapshotCreatedAt: Date | null;
  completedAt: Date | null;
};

const formatDateTime = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney'
  }).format(value);

const formatMoney = (currency: string, rawAmount: string): string =>
  new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(rawAmount));

export function ReconciliationSummary({
  metrics,
  syncCompletedAt,
  reconciliationCurrent
}: {
  metrics: ReconciliationMetrics;
  syncCompletedAt: Date | null;
  reconciliationCurrent: boolean;
}) {
  return (
    <section className="panel reconciliation-panel">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">Xero reconciliation</span>
          <h2>Current receivables summary</h2>
        </div>
        <span
          className={`status-chip ${reconciliationCurrent ? 'status-chip--accepted' : 'status-chip--unknown'}`}
        >
          {reconciliationCurrent
            ? 'Reconciliation complete'
            : 'Acknowledgement required'}
        </span>
      </div>
      <p className="reconciliation-sync">
        Last successful sync:{' '}
        <strong>
          {syncCompletedAt === null
            ? 'No successful sync recorded'
            : formatDateTime(syncCompletedAt)}
        </strong>
      </p>
      <dl className="reconciliation-metrics">
        <div>
          <dt>Active contacts</dt>
          <dd>{metrics.activeContactCount.toLocaleString('en-AU')}</dd>
        </div>
        <div>
          <dt>Outstanding invoices</dt>
          <dd>{metrics.outstandingInvoiceCount.toLocaleString('en-AU')}</dd>
        </div>
        <div>
          <dt>Pending approvals</dt>
          <dd>{metrics.generatedApprovalCount.toLocaleString('en-AU')}</dd>
        </div>
        <div>
          <dt>Enabled sequences</dt>
          <dd>{metrics.enabledSequenceCount.toLocaleString('en-AU')}</dd>
        </div>
      </dl>
      <div className="reconciliation-totals">
        <strong>Total outstanding by currency</strong>
        {Object.entries(metrics.outstandingTotals).length === 0 ? (
          <p>No outstanding authorised receivables were imported.</p>
        ) : (
          <ul>
            {Object.entries(metrics.outstandingTotals).map(
              ([currency, amount]) => (
                <li key={currency}>
                  <span>{currency}</span>
                  <strong>{formatMoney(currency, amount)}</strong>
                </li>
              )
            )}
          </ul>
        )}
      </div>
      <p className="settings-copy">
        Enabled sequences:{' '}
        <strong>
          {metrics.allEnabledSequencesReview
            ? 'all are in Review'
            : 'one or more are Automatic'}
        </strong>
      </p>
    </section>
  );
}

export function ResetStatusPanel({
  operationalState,
  resetRun
}: {
  operationalState: string;
  resetRun: ResetRun | null;
}) {
  const deletionComplete = resetRun?.status === 'COMPLETED';
  const resetAborted = resetRun?.status === 'ABORTED';
  const syncComplete =
    deletionComplete &&
    ![
      'SYNC_REQUIRED',
      'RESET_PREPARING',
      'RESET_IN_PROGRESS',
      'RESET_FAILED'
    ].includes(operationalState);
  const reconciliationComplete =
    deletionComplete && operationalState === 'RECONCILED';
  const heading =
    resetRun === null
      ? 'No reset in progress'
      : {
          PREPARING: 'Reset preparation in progress',
          SNAPSHOT_CREATED: 'Snapshot ready',
          RESETTING: 'Operational data deletion in progress',
          COMPLETED: 'Reset complete',
          FAILED: 'Reset needs attention',
          ABORTED: 'Reset aborted'
        }[resetRun.status];

  return (
    <section className="panel reset-status-panel">
      <span className="eyebrow">Protected operational reset</span>
      <h2>{heading}</h2>
      <p className="settings-copy">
        Reset execution is available only through the protected release
        workflow. There is no destructive control on this page.
      </p>
      <ol className="reset-progress">
        <li className={resetRun !== null ? 'is-complete' : ''}>
          Reset preparation
        </li>
        <li className={resetRun?.snapshotCreatedAt ? 'is-complete' : ''}>
          Snapshot created
        </li>
        <li className={deletionComplete ? 'is-complete' : ''}>
          Operational data deleted
        </li>
        <li className={syncComplete ? 'is-complete' : ''}>
          {resetAborted
            ? 'Fresh Xero sync not required — reset aborted'
            : syncComplete
              ? 'Fresh Xero sync complete'
              : 'Fresh Xero sync required'}
        </li>
        <li className={reconciliationComplete ? 'is-complete' : ''}>
          {resetAborted
            ? 'Reconciliation not required — reset aborted'
            : reconciliationComplete
            ? 'Reconciliation complete'
            : 'Reconciliation required'}
        </li>
      </ol>
      {resetRun?.snapshotIdentifier && (
        <p className="reset-evidence">
          Snapshot evidence: <code>{resetRun.snapshotIdentifier}</code>
        </p>
      )}
      {resetRun?.completedAt && (
        <p className="reset-evidence">
          Deletion completed: <time>{formatDateTime(resetRun.completedAt)}</time>
        </p>
      )}
    </section>
  );
}
