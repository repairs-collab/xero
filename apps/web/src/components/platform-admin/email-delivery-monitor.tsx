import type {
  LifecycleEmailFailureCategory,
  LifecycleEmailMonitoringSnapshot,
  LifecycleEmailStatus,
  LifecycleEmailTemplate
} from '@bc5000/db/web';

const templateLabels: Record<LifecycleEmailTemplate, string> = {
  WORKSPACE_WELCOME: 'Workspace welcome',
  ONBOARDING_COMPLETED: 'Onboarding completed',
  PAYMENT_CONFIRMED: 'Payment confirmed',
  SMS_USAGE_WARNING: 'SMS usage warning',
  PAYMENT_FAILED: 'Payment failed',
  PAYMENT_RECOVERED: 'Payment recovered',
  CANCELLATION_SCHEDULED: 'Cancellation scheduled',
  CANCELLATION_EFFECTIVE: 'Cancellation effective',
  EXPORT_DELIVERED: 'Export delivery recorded',
  PRIVACY_REQUEST_RECEIVED: 'Privacy request received'
};

const statusLabels: Record<LifecycleEmailStatus, string> = {
  PENDING: 'Pending',
  SENDING: 'Sending',
  RETRY: 'Retry scheduled',
  SENT: 'Sent',
  FAILED: 'Failed',
  UNKNOWN: 'Manual investigation required',
  CANCELLED: 'Cancelled'
};

const failureLabels: Record<LifecycleEmailFailureCategory, string> = {
  NONE: 'No failure recorded',
  DELIVERY_RETRY: 'Delivery will be retried',
  DELIVERY_REJECTED: 'Delivery rejected',
  DELIVERY_UNCERTAIN: 'Delivery outcome uncertain',
  PRE_ACTIVATION: 'Cancelled before email activation',
  RECIPIENT_ACCESS: 'Recipient no longer has administrator access',
  OTHER: 'Other safe failure category'
};

const formatDateTime = (value: Date | null): string =>
  value === null
    ? '—'
    : new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Sydney',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      }).format(value);

export function EmailDeliveryMonitor({
  snapshot
}: {
  snapshot: LifecycleEmailMonitoringSnapshot;
}) {
  const metricCards = [
    ['Pending or retrying', snapshot.metrics.pendingOrRetry],
    ['Manual investigation', snapshot.metrics.unknown],
    ['Failed in last 24 hours', snapshot.metrics.failedLast24Hours],
    ['Sent in last 24 hours', snapshot.metrics.sentLast24Hours]
  ] as const;

  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <span className="eyebrow">Owner operations</span>
          <h1>Email delivery</h1>
          <p>Read-only lifecycle email status with customer content and provider details removed.</p>
        </div>
      </header>

      <section className="server-health-grid" aria-label="Lifecycle email summary">
        {metricCards.map(([label, value]) => (
          <article className="server-health-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>

      <section className="panel" aria-labelledby="recent-email-deliveries">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Latest 50</span>
            <h2 id="recent-email-deliveries">Recent lifecycle deliveries</h2>
          </div>
          <small>Newest activity first</small>
        </div>
        {snapshot.rows.length === 0 ? (
          <p>No lifecycle email delivery activity has been recorded.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Notice</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Failure category</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.organisationName}</strong>
                      <small>{row.organisationId}</small>
                    </td>
                    <td>{templateLabels[row.template]}</td>
                    <td>{statusLabels[row.status]}</td>
                    <td>{row.attempts}</td>
                    <td>{failureLabels[row.failureCategory]}</td>
                    <td><time dateTime={row.updatedAt.toISOString()}>{formatDateTime(row.updatedAt)}</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
