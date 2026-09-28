import Link from 'next/link';

import type { InvoiceDetailsModel } from '../app/(protected)/invoices/[invoiceId]/invoice-details.js';

const titleCase = (value: string): string =>
  value
    .toLocaleLowerCase('en-AU')
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toLocaleUpperCase('en-AU'));

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeZone: 'Australia/Sydney'
  }).format(new Date(`${value}T00:00:00.000Z`));

const formatDateTime = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney'
  }).format(value);

const formatMoney = (value: string | null, currency: string): string =>
  value === null
    ? 'Not stored'
    : new Intl.NumberFormat('en-AU', {
        style: 'currency',
        currency
      }).format(Number(value));

export function InvoiceDetailsView({ model }: { model: InvoiceDetailsModel }) {
  const { invoice, contact } = model;
  return (
    <div className="page-stack invoice-details-page">
      <Link className="back-link" href={`/customers/${contact.id}`}>
        ← Back to {contact.name}
      </Link>
      <header className="page-heading page-heading--split invoice-heading">
        <div>
          <span className="eyebrow">Synced Xero invoice</span>
          <h1>{invoice.invoiceNumber}</h1>
          <p>
            <Link href={`/customers/${contact.id}`}>{contact.name}</Link> ·{' '}
            {titleCase(invoice.status)}
          </p>
        </div>
        <div className="invoice-heading__amount">
          <small>Amount due</small>
          <strong>{formatMoney(invoice.amountDue, invoice.currency)}</strong>
        </div>
      </header>

      {model.whitelistEntries.length > 0 && (
        <aside className="sending-banner invoice-whitelist-banner">
          <strong>Reminder chasing is excluded</strong>
          {model.whitelistEntries.map((entry) => (
            <span key={entry.id}>
              {entry.scope === 'CLIENT' ? 'Client-wide' : 'This invoice'}: {' '}
              {entry.reason ?? 'No reason supplied'}
            </span>
          ))}
        </aside>
      )}

      <div className="invoice-details-grid">
        <section className="panel invoice-facts">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Stored values</span>
              <h2>Invoice summary</h2>
            </div>
          </div>
          <dl>
            <div><dt>Status</dt><dd>{titleCase(invoice.status)}</dd></div>
            <div><dt>Type</dt><dd>{invoice.type}</dd></div>
            <div><dt>Issue date</dt><dd>{formatDate(invoice.issueDate)}</dd></div>
            <div><dt>Due date</dt><dd>{formatDate(invoice.dueDate)}</dd></div>
            <div><dt>Amount due</dt><dd>{formatMoney(invoice.amountDue, invoice.currency)}</dd></div>
            <div><dt>Total</dt><dd>{formatMoney(invoice.total, invoice.currency)}</dd></div>
            <div><dt>Currency</dt><dd>{invoice.currency}</dd></div>
            <div><dt>Xero invoice ID</dt><dd><code>{invoice.xeroInvoiceId}</code></dd></div>
            <div><dt>Sync version</dt><dd>{invoice.syncVersion}</dd></div>
            <div>
              <dt>Last Xero update</dt>
              <dd>{invoice.xeroUpdatedAt === null ? 'Not supplied by Xero' : formatDateTime(invoice.xeroUpdatedAt)}</dd>
            </div>
          </dl>
          {invoice.onlineInvoiceUrl === null ? (
            <p className="invoice-link-missing">No online invoice link is stored.</p>
          ) : (
            <a
              className="button button--primary"
              href={invoice.onlineInvoiceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open online invoice
            </a>
          )}
        </section>

        <section className="panel invoice-chase-state">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">AccountPulse</span>
              <h2>Chase state</h2>
            </div>
          </div>
          {model.chases.length === 0 ? (
            <p>No reminder sequence has been attached to this invoice.</p>
          ) : (
            model.chases.map(({ chase, sequenceName }) => (
              <article key={chase.id}>
                <strong>{sequenceName}</strong>
                <span>{titleCase(chase.status)}</span>
                <small>Started {formatDateTime(chase.startedAt)}</small>
                {chase.closedReason !== null && <p>{chase.closedReason}</p>}
              </article>
            ))
          )}
          <Link className="text-link" href={`/outbox?search=${encodeURIComponent(invoice.invoiceNumber)}`}>
            Search this invoice in Outbox
          </Link>
        </section>
      </div>

      <section className="panel invoice-history">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Outgoing activity</span>
            <h2>Message history</h2>
          </div>
          <span className="status-chip">{model.messages.length}</span>
        </div>
        {model.messages.length === 0 ? (
          <p>No outgoing activity is recorded for this invoice.</p>
        ) : (
          <div className="invoice-history-list">
            {model.messages.map((message) => (
              <article key={message.id}>
                <div>
                  <span className="channel-pill">
                    {message.channel === 'SMS' ? 'SMS' : 'Xero email'}
                  </span>
                  <strong>{titleCase(message.source)}</strong>
                  <small>{message.recipient}</small>
                </div>
                <p>
                  {message.content ??
                    'Content was not retained for this historical message.'}
                </p>
                {message.channel === 'XERO_EMAIL' && (
                  <small>Xero controls the rendered email body.</small>
                )}
                <div>
                  <span className={`status-chip status-chip--${message.status.toLowerCase()}`}>
                    {titleCase(message.status)}
                  </span>
                  <time dateTime={message.createdAt.toISOString()}>
                    {formatDateTime(message.createdAt)}
                  </time>
                  {message.failureReason !== null && <small>{message.failureReason}</small>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
