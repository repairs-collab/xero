import { approveReminder, bulkApproveReminders, rejectReminder, snoozeReminder } from '../app/(protected)/approvals/actions.js';
import { MessagePreview } from './message-preview.js';

export interface ApprovalRow {
  id: string;
  organisationId: string;
  customer: string;
  invoiceNumber: string;
  amount: string;
  ageDays: number;
  stage: string;
  channel: 'SMS' | 'XERO_EMAIL' | 'TASK';
  destination: string;
  content: string;
  encoding: string;
  segmentCount: number;
  sourceVersion: number;
  eligibility: string;
}

export function ApprovalTable({ rows }: { rows: ApprovalRow[] }) {
  if (rows.length === 0) return <div className="empty-state"><span>✓</span><h2>You&apos;re all caught up</h2><p>No reminders are waiting for approval.</p></div>;
  return (
    <div>
      <form id="bulk-approval-form" action={bulkApproveReminders} className="table-toolbar"><input type="hidden" name="organisationId" value={rows[0]?.organisationId} /><span><strong>{rows.length}</strong> reminders ready</span><button className="button button--primary" type="submit">Approve selected</button></form>
      <div className="approval-list">
        {rows.map((row) => (
          <article className="approval-card" key={row.id}>
            <label className="approval-check"><input form="bulk-approval-form" type="checkbox" name="approvalId" value={row.id} aria-label={`Select ${row.invoiceNumber}`} /></label>
            <div className="approval-main">
              <div className="approval-title"><div><strong>{row.customer}</strong><span>{row.invoiceNumber} · {row.amount} · {row.ageDays} days overdue</span></div><span className={`channel-pill channel-pill--${row.channel.toLowerCase()}`}>{row.channel === 'XERO_EMAIL' ? 'Xero email' : row.channel}</span></div>
              <div className="eligibility"><span aria-hidden="true">✓</span>{row.eligibility}</div>
              <MessagePreview {...row} />
            </div>
            <form className="approval-actions">
              <input type="hidden" name="organisationId" value={row.organisationId} />
              <input type="hidden" name="approvalId" value={row.id} />
              <button className="button button--primary" formAction={approveReminder}>Approve</button>
              <button className="button" formAction={rejectReminder}>Reject</button>
              <label className="snooze-label">Snooze until<input name="until" type="datetime-local" /></label>
              <button className="button button--quiet" formAction={snoozeReminder}>Snooze</button>
            </form>
          </article>
        ))}
      </div>
    </div>
  );
}
