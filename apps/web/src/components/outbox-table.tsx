import Link from 'next/link';

import type { OutboxRow } from '../app/(protected)/outbox/outbox-query.js';

const sourceLabels: Record<OutboxRow['source'], string> = {
  AUTOMATED_REMINDER: 'Automated reminder',
  MANUAL_REMINDER: 'Manual reminder',
  ESCALATION_SMS: 'Escalation SMS',
  INBOX_REPLY: 'Inbox reply',
  TEST_SMS: 'Test SMS',
  XERO_EMAIL: 'Xero email'
};

const statusLabels: Record<OutboxRow['status'], string> = {
  PENDING: 'Pending',
  QUEUED: 'Queued',
  SENDING: 'Sending',
  DRY_RUN: 'Dry run',
  ACCEPTED: 'Accepted',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown',
  CANCELLED: 'Cancelled'
};

const formatDate = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney'
  }).format(value);

const contentFor = (row: OutboxRow) => {
  if (row.content === null) {
    return (
      <p className="outbox-content outbox-content--muted">
        Content was not retained for this historical message.
      </p>
    );
  }
  if (row.channel === 'XERO_EMAIL') {
    return (
      <div className="outbox-content">
        <p>{row.content}</p>
        <small>
          Xero controls the rendered email body; AccountPulse records the
          invoice-email request only.
        </small>
      </div>
    );
  }
  return <p className="outbox-content">{row.content}</p>;
};

export function OutboxTable({ rows }: { rows: OutboxRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state outbox-empty">
        <h2>No outgoing messages match these filters</h2>
        <p>Try a broader date range or clear one of the filters.</p>
      </div>
    );
  }

  return (
    <div className="outbox-table" role="table" aria-label="Outgoing messages">
      <div className="outbox-row outbox-row--header" role="row">
        <span role="columnheader">Sent to</span>
        <span role="columnheader">Message</span>
        <span role="columnheader">Result</span>
        <span role="columnheader">When</span>
      </div>
      {rows.map((row) => (
        <article className="outbox-row" role="row" key={row.id}>
          <div className="outbox-destination" role="cell">
            <strong>{row.recipient}</strong>
            <div className="outbox-links">
              {row.contactId !== null && row.contactName !== null ? (
                <Link href={`/customers/${row.contactId}`}>{row.contactName}</Link>
              ) : (
                <span>No linked client</span>
              )}
              {row.invoiceId !== null && row.invoiceNumber !== null ? (
                <Link href={`/invoices/${row.invoiceId}`}>{row.invoiceNumber}</Link>
              ) : (
                <span>No linked invoice</span>
              )}
            </div>
          </div>
          <div role="cell">
            <div className="outbox-message-meta">
              <span className={`channel-pill channel-pill--${row.channel === 'SMS' ? 'sms' : 'email'}`}>
                {row.channel === 'SMS' ? 'SMS' : 'Xero email'}
              </span>
              <span>{sourceLabels[row.source]}</span>
              <span>{row.actorName ?? 'AccountPulse'}</span>
            </div>
            {contentFor(row)}
          </div>
          <div className="outbox-result" role="cell">
            <span className={`status-chip status-chip--${row.status.toLowerCase()}`}>
              {statusLabels[row.status]}
            </span>
            <small>{row.failureReason ?? row.providerStatus ?? 'Recorded'}</small>
            {row.providerMessageId !== null && <code>{row.providerMessageId}</code>}
          </div>
          <div className="outbox-time" role="cell">
            <time dateTime={row.createdAt.toISOString()}>{formatDate(row.createdAt)}</time>
            {row.completedAt !== null && (
              <small>Completed {formatDate(row.completedAt)}</small>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
