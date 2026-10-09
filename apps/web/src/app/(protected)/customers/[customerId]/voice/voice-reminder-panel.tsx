import Link from 'next/link';

import type {
  VoiceDraftExcludedInvoice,
  VoiceInvoiceExclusionReason,
  VoicePolicyBlockCode
} from '@bc5000/domain';

import type { VoiceCallDraftView } from './voice-call-service.js';

type VoiceAction = (formData: FormData) => Promise<void>;

const blockMessages: Record<VoicePolicyBlockCode, string> = {
  FEATURE_DISABLED: 'Manual voice reminders are not enabled yet',
  PERMISSION_DENIED: 'Your account cannot place voice reminders',
  INVALID_DESTINATION: 'No usable voice phone number',
  VOICE_SUPPRESSED: 'Voice calls are suppressed for this number',
  DISPUTE_OPEN: 'Resolve the open dispute before calling',
  PROMISE_ACTIVE: 'The active promise to pay protects this account',
  PAUSED: 'Voice chasing is paused for this account',
  WHITELISTED: 'This account is excluded from reminder contact',
  STALE_ACCOUNT_DATA: 'Refresh the Xero account data before calling',
  NO_ELIGIBLE_INVOICES: 'No overdue invoices are currently eligible',
  ORGANISATION_CALL_IN_FLIGHT: 'Another voice reminder is already in progress',
  WEEKLY_FREQUENCY_LIMIT: 'The seven-day voice-call limit has been reached',
  MONTHLY_FREQUENCY_LIMIT: 'The monthly voice-call limit has been reached',
  CALLING_WINDOW_CLOSED: 'Voice calls are outside the permitted calling window'
};

const exclusionMessages: Record<VoiceInvoiceExclusionReason, string> = {
  DUPLICATE_INVOICE: 'Duplicate invoice',
  NOT_ACCREC: 'Not a sales invoice',
  NOT_AUTHORISED: 'Not authorised in Xero',
  NO_BALANCE: 'No balance owing',
  NOT_OVERDUE: 'Not yet overdue',
  CONTACT_INACTIVE: 'Customer is inactive',
  INVOICE_INACTIVE: 'Invoice is inactive',
  INVOICE_PAUSED: 'Invoice reminders are paused',
  CUSTOMER_PAUSED: 'Customer reminders are paused',
  SEQUENCE_PAUSED: 'Reminder sequence is paused',
  WHITELISTED: 'Excluded from reminders',
  DISPUTED: 'Invoice is disputed',
  PROMISE_TO_PAY_ACTIVE: 'Protected by a promise to pay',
  NO_ACTIVE_CHASE: 'No active reminder sequence',
  CURRENCY_MISMATCH: 'Invoice currency does not match the account'
};

const money = (currency: string, amount: string): string =>
  new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency
  }).format(Number(amount));

const attemptsLabel = (count: number, period: string): string =>
  `${count} ${count === 1 ? 'attempt' : 'attempts'} ${period}`;

const excludedReason = (invoice: VoiceDraftExcludedInvoice): string =>
  invoice.reasons.map((reason) => exclusionMessages[reason]).join(', ');

export function VoiceReminderStart({
  organisationId,
  customerId,
  idempotencyKey,
  action
}: {
  organisationId: string;
  customerId: string;
  idempotencyKey: string;
  action: VoiceAction;
}) {
  return (
    <form action={action} className="voice-reminder-start">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <button className="button button--primary" type="submit">
        Make automated call
      </button>
    </form>
  );
}

export function VoiceReminderPanel({
  organisationId,
  draft,
  action
}: {
  organisationId: string;
  draft: VoiceCallDraftView;
  action: VoiceAction;
}) {
  const canSubmit =
    draft.allowed &&
    draft.voiceCallId !== null &&
    draft.approvedFacts !== null &&
    draft.approvedFactsHash !== null;
  const blockMessage =
    draft.blockCode === null ? null : blockMessages[draft.blockCode];

  return (
    <section className="panel voice-reminder-panel" aria-labelledby="voice-reminder-title">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">Manual account call</span>
          <h2 id="voice-reminder-title">Voice reminder review</h2>
          <p>
            Review the exact account facts before placing one combined call.
          </p>
        </div>
        <span className={canSubmit ? 'status-chip' : 'status-chip status-chip--paused'}>
          {canSubmit ? 'Ready for confirmation' : 'Call blocked'}
        </span>
      </div>

      {blockMessage === null ? null : (
        <div className="suppression-warning" role="alert">
          <strong>{blockMessage}</strong>
          {draft.blockCode === 'INVALID_DESTINATION' ? (
            <Link href={`/customers/${draft.customerId}?editPhone=1#sms-phone`}>
              Fix contact number
            </Link>
          ) : null}
        </div>
      )}

      <dl className="voice-reminder-facts">
        <div>
          <dt>Customer</dt>
          <dd>{draft.customerName}</dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>{draft.destinationNumber ?? 'No usable number'}</dd>
        </div>
        <div>
          <dt>Combined balance</dt>
          <dd>{money(draft.currency, draft.combinedAmount)}</dd>
        </div>
        <div>
          <dt>Calling from</dt>
          <dd>{draft.outboundNumber ?? 'Not configured'}</dd>
        </div>
        <div>
          <dt>Recent attempts</dt>
          <dd>
            {attemptsLabel(draft.attemptsLastSevenDays, 'in the last 7 days')}
            {' · '}
            {attemptsLabel(draft.attemptsThisMonth, 'this month')}
          </dd>
        </div>
        <div>
          <dt>Approved flow</dt>
          <dd>Call-flow version {draft.callFlowVersion}</dd>
        </div>
      </dl>

      {draft.nextPermittedAt === null ? null : (
        <p className="voice-reminder-next-time">
          Next permitted time:{' '}
          {new Intl.DateTimeFormat('en-AU', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Australia/Sydney'
          }).format(draft.nextPermittedAt)}
        </p>
      )}

      <div className="voice-reminder-columns">
        <section>
          <h3>Included invoices</h3>
          {draft.includedInvoices.length === 0 ? (
            <p>No eligible invoices.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Due</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {draft.includedInvoices.map((invoice) => (
                  <tr key={invoice.invoiceId}>
                    <td>{invoice.invoiceNumber}</td>
                    <td>{invoice.dueDate}</td>
                    <td>{money(invoice.currency, invoice.amountDue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h3>Excluded invoices</h3>
          {draft.excludedInvoices.length === 0 ? (
            <p>None.</p>
          ) : (
            <ul>
              {draft.excludedInvoices.map((invoice) => (
                <li key={`${invoice.id}:${invoice.invoiceNumber}`}>
                  <strong>{invoice.invoiceNumber}</strong>: {excludedReason(invoice)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="voice-call-flow-summary">
        <h3>What the customer will hear</h3>
        <ul>
          <li>Press 1 confirms the recipient is authorised before invoice details are read.</li>
          <li>
            Press 2 transfers to {draft.transferTargetLabel ?? 'the office'} without
            disclosing account facts first.
          </li>
          <li>Wrong person ends the call and suppresses further calls to that number.</li>
          <li>Voicemail receives a generic callback message with no account details.</li>
        </ul>
      </section>

      <section className="voice-final-confirmation">
        <span className="eyebrow">Final confirmation</span>
        <h3>
          Call {draft.customerName} on {draft.destinationNumber ?? 'the selected number'}
        </h3>
        <p>
          {draft.includedInvoices.map((invoice) => invoice.invoiceNumber).join(', ') ||
            'No eligible invoices'}
          {' · '}
          {money(draft.currency, draft.combinedAmount)}
        </p>
        <p>
          Calling from {draft.outboundNumber ?? 'an unconfigured number'} · Call-flow
          version {draft.callFlowVersion} · Transfer to{' '}
          {draft.transferTargetLabel ?? 'the office'}
        </p>

        {canSubmit ? (
          <form action={action}>
            <input type="hidden" name="organisationId" value={organisationId} />
            <input type="hidden" name="customerId" value={draft.customerId} />
            <input type="hidden" name="voiceCallId" value={draft.voiceCallId ?? ''} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={draft.idempotencyKey}
            />
            <input
              type="hidden"
              name="callFlowVersion"
              value={draft.callFlowVersion}
            />
            <input type="hidden" name="callFlowHash" value={draft.callFlowHash} />
            <input
              type="hidden"
              name="approvedFactsHash"
              value={draft.approvedFactsHash ?? ''}
            />
            <label className="manual-confirmation">
              <input type="checkbox" name="confirmed" value="yes" required />
              I confirm these exact account facts and the approved call flow are ready.
            </label>
            <button className="button button--primary" type="submit">
              Confirm and place call
            </button>
          </form>
        ) : (
          <button className="button button--primary" type="button" disabled>
            Confirm and place call
          </button>
        )}
      </section>
    </section>
  );
}
