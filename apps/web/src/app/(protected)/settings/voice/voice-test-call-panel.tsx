import type { VoiceTestCallView } from './voice-test-call-service.js';

type VoiceTestAction = (formData: FormData) => Promise<void>;

const money = (currency: string, amount: string): string =>
  new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency
  }).format(Number(amount));

export function VoiceTestCallPanel({
  organisationId,
  ready,
  idempotencyKey,
  draft,
  prepareAction,
  approveAction
}: {
  organisationId: string;
  ready: boolean;
  idempotencyKey: string;
  draft: VoiceTestCallView | null;
  prepareAction: VoiceTestAction;
  approveAction: VoiceTestAction;
}) {
  return (
    <section className="panel voice-test-call-panel">
      <div className="panel__heading">
        <div>
          <span className="eyebrow">Administrator test sending</span>
          <h2>Test voice call</h2>
        </div>
        <span className="status-chip">TEST</span>
      </div>
      <p>
        Enter an existing Xero invoice and a staff-controlled number. The call
        uses the real locked flow and invoice facts without changing the
        customer&apos;s saved contact details or Customer Live settings.
      </p>
      {!ready ? (
        <div className="suppression-warning" role="alert">
          Complete the provider test and fictional flow test first.
        </div>
      ) : null}
      <form action={prepareAction} className="settings-form">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <label>
          Existing invoice number
          <input name="invoiceNumber" placeholder="INV-100" required />
        </label>
        <label>
          Staff-controlled test number
          <input
            name="testNumber"
            inputMode="tel"
            placeholder="0400 000 000"
            required
          />
        </label>
        <button className="button" disabled={!ready}>
          Review test call
        </button>
      </form>

      {draft === null ? null : (
        <div className="voice-test-call-review">
          <h3>Confirm test call</h3>
          <dl className="voice-reminder-facts">
            <div>
              <dt>Invoice</dt>
              <dd>{draft.invoiceNumber}</dd>
            </div>
            <div>
              <dt>Xero customer</dt>
              <dd>{draft.customerName}</dd>
            </div>
            <div>
              <dt>Test destination</dt>
              <dd>{draft.destinationNumber}</dd>
            </div>
            <div>
              <dt>Outstanding amount</dt>
              <dd>{money(draft.currency, draft.amountDue)}</dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>{draft.dueDate}</dd>
            </div>
          </dl>
          <form action={approveAction} className="settings-form">
            <input type="hidden" name="organisationId" value={organisationId} />
            <input type="hidden" name="voiceCallId" value={draft.voiceCallId} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={draft.idempotencyKey}
            />
            <label className="manual-confirmation">
              <input type="checkbox" name="confirmed" value="yes" required />
              I confirm this number is controlled by staff and this test call
              is ready.
            </label>
            <button className="button button--primary">
              Place test voice call
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
