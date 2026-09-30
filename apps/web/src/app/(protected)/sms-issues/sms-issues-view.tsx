import Link from 'next/link';

import type {
  SmsIssueCustomer,
  SmsIssueSections
} from './sms-issue-service.js';

const money = (amount: string, currency: string): string =>
  new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency
  }).format(Number(amount));

const date = (value: string): string =>
  new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium' }).format(
    new Date(`${value}T00:00:00.000Z`)
  );

function IssueCard({
  issue,
  fixable
}: {
  issue: SmsIssueCustomer;
  fixable: boolean;
}) {
  return (
    <article className="sms-issue-card">
      <div className="sms-issue-card__customer">
        <div>
          <strong>{issue.customerName}</strong>
          <span>{issue.email ?? 'No email in Xero'}</span>
        </div>
        <span className={`status-chip ${fixable ? 'status-chip--warning' : 'status-chip--muted'}`}>
          {fixable ? 'Mobile required' : 'SMS suppressed'}
        </span>
      </div>
      <p>
        {fixable
          ? 'No valid mobile number was found. Add a verified phone override or correct the contact in Xero.'
          : 'STOP received or another active suppression prevents SMS delivery. This cannot be bypassed here.'}
      </p>
      {!fixable && issue.destination !== null && (
        <small>Blocked destination: {issue.destination}</small>
      )}
      <div className="sms-issue-card__invoices">
        {issue.invoices.map((invoice) => (
          <Link href={`/invoices/${invoice.id}`} key={invoice.id}>
            <strong>{invoice.invoiceNumber}</strong>
            <span>{money(invoice.amountDue, invoice.currency)}</span>
            <small>Due {date(invoice.dueDate)}</small>
          </Link>
        ))}
      </div>
      <Link
        className={`button ${fixable ? 'button--primary' : 'button--quiet'}`}
        href={`/customers/${issue.customerId}${fixable ? '?editPhone=1#sms-phone' : ''}`}
      >
        {fixable ? 'Fix client details' : 'View client'}
      </Link>
    </article>
  );
}

function IssueSection({
  title,
  description,
  emptyMessage,
  rows,
  fixable
}: {
  title: string;
  description: string;
  emptyMessage: string;
  rows: SmsIssueCustomer[];
  fixable: boolean;
}) {
  return (
    <section className="panel sms-issue-section">
      <div className="panel__heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="status-chip">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="sms-issues-empty">{emptyMessage}</p>
      ) : (
        <div className="sms-issue-list">
          {rows.map((row) => (
            <IssueCard issue={row} fixable={fixable} key={row.customerId} />
          ))}
        </div>
      )}
    </section>
  );
}

export function SmsIssuesView({ sections }: { sections: SmsIssueSections }) {
  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">Delivery readiness</span>
        <h1>SMS Issues</h1>
        <p>
          Find outstanding invoices that AccountPulse cannot currently message
          and see what needs attention.
        </p>
      </header>
      <aside className="sending-banner">
        Correcting contact details can make eligible Automatic reminders send
        during today&apos;s permitted sending window. Compliance suppressions are
        never bypassed.
      </aside>
      <div className="sms-issues-grid">
        <IssueSection
          title="Contact details needed"
          description="These clients have outstanding invoices but no usable mobile number."
          emptyMessage="Every actively chased invoice has a usable mobile number."
          rows={sections.contactDetailsNeeded}
          fixable
        />
        <IssueSection
          title="Compliance blocked"
          description="These clients have a valid number that is currently suppressed."
          emptyMessage="No actively chased clients are blocked by an SMS suppression."
          rows={sections.complianceBlocked}
          fixable={false}
        />
      </div>
    </div>
  );
}
