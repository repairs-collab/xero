import { CheckIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';

import {
  addApprovalTargetToWhitelist,
  approveReminder,
  bulkApproveReminders,
  rejectReminder,
  snoozeReminder
} from '../app/(protected)/approvals/actions.js';
import { MessagePreview } from './message-preview.js';
import { ReminderWhitelistControls } from './reminder-whitelist-controls.js';

interface ApprovalRowBase {
  id: string;
  organisationId: string;
  contactId: string;
  customer: string;
  stage: string;
  destination: string;
  eligibility: string;
}

export interface MessageApprovalRow extends ApprovalRowBase {
  kind: 'MESSAGE';
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
  ageDays: number;
  channel: 'SMS' | 'XERO_EMAIL' | 'TASK';
  content: string;
  encoding: string;
  segmentCount: number;
  sourceVersion: number;
}

export interface VoiceApprovalInvoiceRow {
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
}

export interface VoiceApprovalRow extends ApprovalRowBase {
  kind: 'VOICE';
  combinedAmount: string;
  scheduledAt: string;
  invoices: VoiceApprovalInvoiceRow[];
}

export type ApprovalRow = MessageApprovalRow | VoiceApprovalRow;

function MessageApprovalCard({ row }: { row: MessageApprovalRow }) {
  return (
    <article className="approval-card">
      <label className="approval-check">
        <input
          form="bulk-approval-form"
          type="checkbox"
          name="approvalId"
          value={row.id}
          aria-label={`Select ${row.invoiceNumber}`}
        />
      </label>
      <div className="approval-main">
        <div className="approval-title">
          <div>
            <strong>
              <Link href={`/customers/${row.contactId}`}>{row.customer}</Link>
            </strong>
            <span>
              <Link href={`/invoices/${row.invoiceId}`}>
                {row.invoiceNumber}
              </Link>{' '}
              · {row.amount} · {row.ageDays} days overdue
            </span>
          </div>
          <span
            className={`channel-pill channel-pill--${row.channel.toLowerCase()}`}
          >
            {row.channel === 'XERO_EMAIL' ? 'Xero email' : row.channel}
          </span>
        </div>
        <div className="eligibility">
          <span aria-hidden="true">
            <CheckIcon />
          </span>
          {row.eligibility}
        </div>
        <MessagePreview {...row} />
      </div>
      <form className="approval-actions">
        <input
          type="hidden"
          name="organisationId"
          value={row.organisationId}
        />
        <input type="hidden" name="kind" value="MESSAGE" />
        <input type="hidden" name="approvalId" value={row.id} />
        <button
          className="button button--primary"
          formAction={approveReminder}
        >
          Approve
        </button>
        <button className="button" formAction={rejectReminder}>
          Reject
        </button>
        <label className="snooze-label">
          Snooze until
          <input name="until" type="datetime-local" />
        </label>
        <button
          className="button button--quiet"
          formAction={snoozeReminder}
        >
          Snooze
        </button>
      </form>
      <ReminderWhitelistControls
        organisationId={row.organisationId}
        contactId={row.contactId}
        invoiceId={row.invoiceId}
        action={addApprovalTargetToWhitelist}
      />
    </article>
  );
}

function VoiceApprovalCard({ row }: { row: VoiceApprovalRow }) {
  return (
    <article className="approval-card">
      <label className="approval-check">
        <input
          form="bulk-approval-form"
          type="checkbox"
          name="voiceCallId"
          value={row.id}
          aria-label={`Select voice call for ${row.customer}`}
        />
      </label>
      <div className="approval-main">
        <div className="approval-title">
          <div>
            <strong>
              <Link href={`/customers/${row.contactId}`}>{row.customer}</Link>
            </strong>
            <span>
              {row.invoices.length} invoice
              {row.invoices.length === 1 ? '' : 's'} · {row.combinedAmount} ·{' '}
              {row.scheduledAt}
            </span>
          </div>
          <span className="channel-pill channel-pill--voice">Voice call</span>
        </div>
        <div className="eligibility">
          <span aria-hidden="true">
            <CheckIcon />
          </span>
          {row.eligibility}
        </div>
        <section aria-label="Included voice call invoices">
          <p>
            <strong>Destination:</strong> {row.destination}
          </p>
          <p>
            <strong>Stage:</strong> {row.stage.replaceAll('-', ' ')}
          </p>
          <ul>
            {row.invoices.map((invoice) => (
              <li key={invoice.invoiceId}>
                <Link href={`/invoices/${invoice.invoiceId}`}>
                  {invoice.invoiceNumber}
                </Link>{' '}
                · {invoice.amount}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <form className="approval-actions">
        <input
          type="hidden"
          name="organisationId"
          value={row.organisationId}
        />
        <input type="hidden" name="kind" value="VOICE" />
        <input type="hidden" name="voiceCallId" value={row.id} />
        <button
          className="button button--primary"
          formAction={approveReminder}
        >
          Approve call
        </button>
        <button className="button" formAction={rejectReminder}>
          Reject call
        </button>
      </form>
    </article>
  );
}

export function ApprovalTable({ rows }: { rows: ApprovalRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <span>
          <CheckIcon aria-hidden="true" />
        </span>
        <h2>You&apos;re all caught up</h2>
        <p>No reminders are waiting for approval.</p>
      </div>
    );
  }
  return (
    <div>
      <form
        id="bulk-approval-form"
        action={bulkApproveReminders}
        className="table-toolbar"
      >
        <input
          type="hidden"
          name="organisationId"
          value={rows[0]?.organisationId}
        />
        <span>
          <strong>{rows.length}</strong> reminders ready
        </span>
        <button className="button button--primary" type="submit">
          Approve selected
        </button>
      </form>
      <div className="approval-list">
        {rows.map((row) =>
          row.kind === 'VOICE' ? (
            <VoiceApprovalCard key={row.id} row={row} />
          ) : (
            <MessageApprovalCard key={row.id} row={row} />
          )
        )}
      </div>
    </div>
  );
}
