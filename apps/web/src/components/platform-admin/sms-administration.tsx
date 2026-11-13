import Link from 'next/link';

import type {
  PlatformNumberPage,
  PlatformReplyNumberProvisioningPage,
  ReplyNumberDocumentationStatus,
  ReplyNumberProvisioningStatus,
  SmsNumberStatus
} from '@bc5000/db/web';

type FormAction = (formData: FormData) => Promise<unknown>;

const provisioningStatuses: ReplyNumberProvisioningStatus[] = [
  'AWAITING_QUOTE',
  'AWAITING_OWNER_APPROVAL',
  'APPROVED_FOR_MANUAL_ORDER',
  'MANUAL_ORDER_RECORDED',
  'FULFILLED',
  'FAILED',
  'EXPIRED'
];
const documentationStatuses: ReplyNumberDocumentationStatus[] = [
  'UNKNOWN',
  'NOT_REQUIRED',
  'REQUIRED',
  'COMPLETE'
];
const activeProvisioningStatuses: ReplyNumberProvisioningStatus[] = [
  'AWAITING_QUOTE',
  'AWAITING_OWNER_APPROVAL',
  'APPROVED_FOR_MANUAL_ORDER',
  'MANUAL_ORDER_RECORDED'
];

const title = (value: string): string =>
  value
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
const dateTime = (value: Date | null): string =>
  value
    ? new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(value)
    : '—';
const aud = (minor: number | null): string =>
  minor === null
    ? '—'
    : new Intl.NumberFormat('en-AU', {
        style: 'currency',
        currency: 'AUD'
      }).format(minor / 100);
const audInput = (minor: number): string => (minor / 100).toFixed(2);
const opaqueReferenceHelp =
  'Use an opaque reference only: letters, numbers, full stops, underscores or hyphens (maximum 128).';

type ProvisioningRequest =
  PlatformReplyNumberProvisioningPage['items'][number];

const RequestIdentityFields = ({ request }: { request: ProvisioningRequest }) => (
  <>
    <input type="hidden" name="organisationId" value={request.organisationId} />
    <input type="hidden" name="requestId" value={request.id} />
    <input type="hidden" name="expectedVersion" value={request.version} />
  </>
);

type SmsAdministrationActions = {
  recordQuote: FormAction;
  completeDocumentation: FormAction;
  approveOrder: FormAction;
  recordOrder: FormAction;
  fulfilOrder: FormAction;
  failRequest: FormAction;
  expireRequest: FormAction;
  register: FormAction;
  verify: FormAction;
  assign: FormAction;
  ready: FormAction;
  quarantine: FormAction;
  release: FormAction;
  returnToPool: FormAction;
};

export function PlatformSmsAdministration({
  page,
  provisioningPage,
  organisations,
  filters,
  provisioningFilters,
  feedbackCode,
  now,
  actions
}: {
  page: PlatformNumberPage;
  provisioningPage: PlatformReplyNumberProvisioningPage;
  organisations: Array<{ id: string; name: string }>;
  filters: {
    search?: string;
    customerSearch?: string;
    status?: SmsNumberStatus | '';
  };
  provisioningFilters: {
    search?: string;
    organisationId?: string;
    status?: ReplyNumberProvisioningStatus | '';
    documentationStatus?: ReplyNumberDocumentationStatus | '';
  };
  feedbackCode?: string;
  now: Date;
  actions: SmsAdministrationActions;
}) {
  const numberTotalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const requestTotalPages = Math.max(
    1,
    Math.ceil(provisioningPage.total / provisioningPage.pageSize)
  );
  const numberPageHref = (target: number): string => {
    const params = new URLSearchParams();
    if (filters.search) params.set('search', filters.search);
    if (filters.customerSearch) params.set('customerSearch', filters.customerSearch);
    if (filters.status) params.set('status', filters.status);
    params.set('page', String(target));
    return `/platform-admin/sms?${params.toString()}`;
  };
  const requestPageHref = (target: number): string => {
    const params = new URLSearchParams();
    if (provisioningFilters.search) {
      params.set('provisioningSearch', provisioningFilters.search);
    }
    if (provisioningFilters.organisationId) {
      params.set(
        'provisioningOrganisationId',
        provisioningFilters.organisationId
      );
    }
    if (provisioningFilters.status) {
      params.set('provisioningStatus', provisioningFilters.status);
    }
    if (provisioningFilters.documentationStatus) {
      params.set(
        'documentationStatus',
        provisioningFilters.documentationStatus
      );
    }
    params.set('provisioningPage', String(target));
    return `/platform-admin/sms?${params.toString()}`;
  };
  const feedback =
    feedbackCode === 'UPDATED'
      ? {
          kind: 'success',
          title: 'Change saved',
          copy: 'The owner-held SMS record is up to date.'
        }
      : feedbackCode
        ? {
            kind: 'warning',
            title:
              feedbackCode === 'CONFLICT'
                ? 'The record changed'
                : feedbackCode === 'QUOTE_EXPIRED'
                  ? 'The written quote expired'
                  : feedbackCode === 'AMOUNT_MISMATCH'
                    ? 'The approved costs did not match'
                    : feedbackCode === 'BILLING_RISK_HOLD'
                      ? 'Customer billing hold'
                      : 'Change not completed',
            copy:
              feedbackCode === 'CONFLICT'
                ? 'This was a stale version. Refresh and review the current request before trying again.'
                : feedbackCode === 'QUOTE_EXPIRED'
                  ? 'Record a new written quote before approving or recording an external order.'
                  : feedbackCode === 'AMOUNT_MISMATCH'
                    ? 'Refresh and confirm the exact setup and monthly amounts shown on the current quote.'
                    : 'Check the submitted values and current workflow state, then try again.'
          }
        : null;
  const assignedNumbers = page.items.filter(
    (item) => !['AVAILABLE', 'RELEASED'].includes(item.status)
  );
  const legacyPoolNumbers = page.items.filter((item) =>
    ['AVAILABLE', 'RELEASED'].includes(item.status)
  );

  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <span className="eyebrow">Owner-only Sinch operations</span>
          <h1>SMS number administration</h1>
          <p>Review manual provisioning holds, verify assigned numbers and manage safe number cooling.</p>
        </div>
      </header>
      {feedback ? (
        <div
          className={`platform-feedback platform-feedback--${feedback.kind}`}
          role={feedback.kind === 'success' ? 'status' : 'alert'}
        >
          <strong>{feedback.title}</strong><span>{feedback.copy}</span>
        </div>
      ) : null}

      <section className="panel platform-table-panel">
        <div>
          <span className="eyebrow">Owner/manual hold</span>
          <h2>Manual reply-number provisioning</h2>
          <p>
            AccountPulse will not contact Sinch, place an order or pay any fee.
            Record only a written quote and redacted references here after you complete
            each provider step outside AccountPulse. Never paste credentials or raw documents.
          </p>
        </div>
        <form className="platform-filters" method="get">
          <label>
            Search requests
            <input type="search" name="provisioningSearch" defaultValue={provisioningFilters.search ?? ''} placeholder="Customer, request, Xero ID or number" />
          </label>
          <label>
            Customer
            <select name="provisioningOrganisationId" defaultValue={provisioningFilters.organisationId ?? ''}>
              <option value="">All customers</option>
              {organisations.map((organisation) => <option key={organisation.id} value={organisation.id}>{organisation.name}</option>)}
            </select>
          </label>
          <label>
            Request status
            <select name="provisioningStatus" defaultValue={provisioningFilters.status ?? ''}>
              <option value="">All statuses</option>
              {provisioningStatuses.map((status) => <option key={status} value={status}>{title(status)}</option>)}
            </select>
          </label>
          <label>
            Documents
            <select name="documentationStatus" defaultValue={provisioningFilters.documentationStatus ?? ''}>
              <option value="">All document states</option>
              {documentationStatuses.map((status) => <option key={status} value={status}>{title(status)}</option>)}
            </select>
          </label>
          <button className="button button--primary" type="submit">Apply</button>
        </form>

        <div className="platform-number-list">
          {provisioningPage.items.length === 0 ? <p>No provisioning requests match these filters.</p> : null}
          {provisioningPage.items.map((request) => {
            const quoteExpired = request.quoteExpiresAt !== null && request.quoteExpiresAt.getTime() <= now.getTime();
            const documentationReady = request.documentationStatus === 'NOT_REQUIRED' || request.documentationStatus === 'COMPLETE';
            const active = activeProvisioningStatuses.includes(request.status);
            return (
              <article key={request.id}>
                <header>
                  <div>
                    <strong>{request.organisationName}</strong>
                    <span>Request {request.id} · Attempt {request.attempt} · Version {request.version}</span>
                  </div>
                  <span className={`platform-status platform-status--${request.status.toLowerCase()}`}>{title(request.status)}</span>
                </header>
                <dl>
                  <div><dt>Xero customer</dt><dd>{request.xeroOrganisationId}</dd></div>
                  <div><dt>Provider</dt><dd>{request.provider}</dd></div>
                  <div><dt>Written quote</dt><dd>{request.quoteSetupFeeMinor === null || request.quoteMonthlyFeeMinor === null ? 'Not recorded' : `${aud(request.quoteSetupFeeMinor)} setup · ${aud(request.quoteMonthlyFeeMinor)} monthly`}</dd></div>
                  <div><dt>Quote expiry</dt><dd>{dateTime(request.quoteExpiresAt)}{quoteExpired ? ' · Expired' : ''}</dd></div>
                  <div><dt>Documents</dt><dd>{title(request.documentationStatus)}</dd></div>
                  <div><dt>Evidence reference</dt><dd>{request.documentationEvidenceReference ?? 'No redacted reference recorded'}</dd></div>
                  <div><dt>External order</dt><dd>{request.externalOrderReference ?? 'Not recorded'}</dd></div>
                  <div><dt>Fulfilled number</dt><dd>{request.fulfilledE164Number ?? 'Not recorded'}</dd></div>
                  <div><dt>Updated</dt><dd>{dateTime(request.updatedAt)}</dd></div>
                </dl>
                <div className="platform-number-actions">
                  {request.status === 'AWAITING_QUOTE' ? (
                    <form action={actions.recordQuote as never}>
                      <RequestIdentityFields request={request} />
                      <label>Setup fee (AUD)<input name="setupFeeAud" inputMode="decimal" placeholder="0.00" required /></label>
                      <label>Monthly fee (AUD)<input name="monthlyFeeAud" inputMode="decimal" placeholder="0.00" required /></label>
                      <label>Written quote expires (Sydney time)<input type="datetime-local" name="quoteExpiresLocal" required /></label>
                      <label>Sydney UTC offset at expiry<select name="quoteUtcOffset" required defaultValue=""><option value="" disabled>Select offset</option><option value="+11:00">Daylight saving (+11:00)</option><option value="+10:00">Standard time (+10:00)</option></select></label>
                      <label>Documentation status<select name="documentationStatus" required defaultValue="NOT_REQUIRED"><option value="NOT_REQUIRED">Not required</option><option value="REQUIRED">Required</option><option value="COMPLETE">Complete</option></select></label>
                      <label>Redacted evidence reference<input name="documentationEvidenceReference" maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" /></label>
                      <small>{opaqueReferenceHelp} Do not paste credentials, links or document contents.</small>
                      <label>Reason<input name="reason" maxLength={500} required /></label>
                      <button className="button button--primary" type="submit">Record written quote</button>
                    </form>
                  ) : null}

                  {request.documentationStatus === 'REQUIRED' && ['AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER'].includes(request.status) ? (
                    <form action={actions.completeDocumentation as never}>
                      <RequestIdentityFields request={request} />
                      <label>Completed documentation reference<input name="documentationEvidenceReference" maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" required /></label>
                      <label>Reason<input name="reason" maxLength={500} required /></label>
                      <small>{opaqueReferenceHelp} Do not upload or paste the document.</small>
                      <button className="button button--primary" type="submit">Mark required documents complete</button>
                    </form>
                  ) : null}

                  {request.status === 'AWAITING_OWNER_APPROVAL' && request.quoteSetupFeeMinor !== null && request.quoteMonthlyFeeMinor !== null && !quoteExpired ? (
                    <form action={actions.approveOrder as never}>
                      <RequestIdentityFields request={request} />
                      <input type="hidden" name="confirmedSetupFeeAud" value={audInput(request.quoteSetupFeeMinor)} />
                      <input type="hidden" name="confirmedMonthlyFeeAud" value={audInput(request.quoteMonthlyFeeMinor)} />
                      <p><strong>{aud(request.quoteSetupFeeMinor)} setup</strong> and <strong>{aud(request.quoteMonthlyFeeMinor)} monthly</strong></p>
                      <label className="platform-confirm"><input type="checkbox" name="approvalConfirmed" required />I approve these exact written costs. This only records approval; it does not order or pay.</label>
                      <label>Type APPROVE EXACT QUOTE<input name="approvalPhrase" pattern="APPROVE EXACT QUOTE" required /></label>
                      <label>Approval reason<input name="reason" maxLength={500} required /></label>
                      <button className="button button--primary" type="submit">Approve exact quote for manual order</button>
                    </form>
                  ) : null}

                  {request.status === 'AWAITING_OWNER_APPROVAL' && quoteExpired ? (
                    <form action={actions.expireRequest as never}>
                      <RequestIdentityFields request={request} />
                      <label>Reason<input name="reason" maxLength={500} defaultValue="Written quote expired before approval" required /></label>
                      <button className="button button--quiet" type="submit">Expire request</button>
                    </form>
                  ) : null}

                  {request.status === 'APPROVED_FOR_MANUAL_ORDER' && documentationReady && !quoteExpired ? (
                    <form action={actions.recordOrder as never}>
                      <RequestIdentityFields request={request} />
                      <label>Redacted external order reference<input name="externalOrderReference" maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" required /></label>
                      <label>Reason<input name="reason" maxLength={500} defaultValue="Order placed outside AccountPulse" required /></label>
                      <small>{opaqueReferenceHelp} Complete the Sinch order outside AccountPulse first; this control records the reference only.</small>
                      <button className="button button--primary" type="submit">Record external order reference</button>
                    </form>
                  ) : null}

                  {request.status === 'APPROVED_FOR_MANUAL_ORDER' && quoteExpired ? (
                    <p><strong>Expired approved quote — do not place an order.</strong> Fail this request below and wait for a replacement written quote.</p>
                  ) : null}

                  {request.status === 'MANUAL_ORDER_RECORDED' ? (
                    <form action={actions.fulfilOrder as never}>
                      <RequestIdentityFields request={request} />
                      <label>Australian E.164 number<input name="e164Number" pattern="[+]61[0-9]{9}" placeholder="+61412345678" required /></label>
                      <label>Sinch provider number reference<input name="providerNumberId" maxLength={128} required /></label>
                      <label>Reason<input name="reason" maxLength={500} defaultValue="Provider supplied the ordered number" required /></label>
                      <small>The number is recorded as assigned and reserved. Complete the separate readiness verification below before customer use.</small>
                      <button className="button button--primary" type="submit">Record fulfilled number</button>
                    </form>
                  ) : null}

                  {request.status === 'FULFILLED' ? <p>Fulfilled. Use the assigned-number readiness check below; fulfilment alone does not enable the number.</p> : null}
                  {active ? (
                    <form action={actions.failRequest as never}>
                      <RequestIdentityFields request={request} />
                      <label>Failure code<input name="failureCode" pattern="[A-Z0-9][A-Z0-9_-]{0,63}" placeholder="PROVIDER_DECLINED" required /></label>
                      <label>Reason<input name="reason" maxLength={500} required /></label>
                      <button className="button button--danger" type="submit">Fail request</button>
                    </form>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        {requestTotalPages > 1 ? (
          <nav className="platform-pagination" aria-label="Provisioning request pages">
            {provisioningPage.page > 1 ? <Link href={requestPageHref(provisioningPage.page - 1)}>← Previous</Link> : <span />}
            <span>Page {provisioningPage.page} of {requestTotalPages}</span>
            {provisioningPage.page < requestTotalPages ? <Link href={requestPageHref(provisioningPage.page + 1)}>Next →</Link> : <span />}
          </nav>
        ) : null}
      </section>

      <section className="panel platform-table-panel">
        <h2>Assigned number verification and lifecycle</h2>
        <p>Fulfilled numbers stay reserved until you separately verify the Sinch reference, outbound sending and inbound replies.</p>
        <div className="platform-number-list">
          {assignedNumbers.length === 0 ? <p>No assigned numbers appear on this inventory page.</p> : null}
          {assignedNumbers.map((item) => (
            <article key={item.id}>
              <header><div><strong>{item.e164Number}</strong><span>{item.provider} · {item.providerNumberId ?? 'Provider ID pending'}</span></div><span className={`platform-status platform-status--${item.status.toLowerCase()}`}>{title(item.status)}</span></header>
              <dl><div><dt>Customer</dt><dd>{item.organisationName ?? 'Unassigned'}</dd></div><div><dt>Pool verification</dt><dd>{item.providerVerifiedAt ? `Verified for automatic allocation · ${dateTime(item.providerVerifiedAt)}` : 'Not verified for automatic allocation'}</dd></div><div><dt>Ready at</dt><dd>{dateTime(item.readyAt)}</dd></div><div><dt>Cooling until</dt><dd>{dateTime(item.quarantineUntil)}</dd></div></dl>
              <div className="platform-number-actions">
                {item.status === 'RESERVED' && item.organisationId ? (
                  <form action={actions.ready as never}>
                    <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="organisationId" value={item.organisationId} /><input type="hidden" name="expectedUpdatedAt" value={item.updatedAt.toISOString()} />
                    <input name="providerNumberId" defaultValue={item.providerNumberId ?? ''} placeholder="Verified Sinch provider ID" required /><input name="reason" placeholder="Verification reason" maxLength={500} required />
                    <button className="button button--primary" type="submit">Mark ready</button>
                  </form>
                ) : null}
                {item.status === 'RESERVED' || item.status === 'READY' ? (
                  <>
                    <form action={actions.quarantine as never}>
                      <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedStatus" value={item.status} /><input type="hidden" name="expectedUpdatedAt" value={item.updatedAt.toISOString()} />
                      <input type="datetime-local" name="quarantineUntil" required /><input name="reason" placeholder="Reason" maxLength={500} required /><button className="button button--quiet" type="submit">Quarantine</button>
                    </form>
                    <form action={actions.release as never}>
                      <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedStatus" value={item.status} /><input type="hidden" name="expectedUpdatedAt" value={item.updatedAt.toISOString()} />
                      <input name="reason" placeholder="Reason" maxLength={500} required /><label className="platform-confirm"><input type="checkbox" name="confirmation" required />Confirm 30-day cooling</label><button className="button button--danger" type="submit">Release number</button>
                    </form>
                  </>
                ) : null}
                {item.status === 'QUARANTINED' ? (
                  <form action={actions.returnToPool as never}>
                    <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedUpdatedAt" value={item.updatedAt.toISOString()} /><input name="reason" placeholder="Reason" maxLength={500} required />
                    <label className="platform-confirm"><input type="checkbox" name="confirmation" required />Cooling is complete</label><button className="button button--primary" type="submit">Return to pool</button>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      <details className="panel platform-table-panel">
        <summary><strong>Legacy spare-number pool</strong> — not used by the five-customer manual beta path</summary>
        <p>These controls remain for existing inventory. New beta customers use the manual request workflow above.</p>
        <section className="platform-registration-panel">
          <div><h2>Register existing Sinch number</h2><p>This records a number you already obtained outside AccountPulse; it does not buy one.</p></div>
          <form action={actions.register as never} className="platform-inline-form">
            <label>Number<input name="e164Number" pattern="[+]61[0-9]{9}" required /></label><label>Sinch provider ID<input name="providerNumberId" maxLength={128} /></label><label>Reason<input name="reason" maxLength={500} required /></label><button className="button button--primary" type="submit">Register existing number</button>
          </form>
        </section>
        <form className="platform-filters" method="get">
          <label>Search numbers<input type="search" name="search" defaultValue={filters.search ?? ''} /></label><label>Find customer<input type="search" name="customerSearch" defaultValue={filters.customerSearch ?? ''} placeholder="Name, email or Xero tenant" /></label><label>Status<select name="status" defaultValue={filters.status ?? ''}><option value="">All statuses</option>{(['AVAILABLE','RESERVED','READY','QUARANTINED','RELEASED'] as const).map((status) => <option key={status} value={status}>{title(status)}</option>)}</select></label><button className="button button--primary" type="submit">Apply</button>
        </form>
        <div className="platform-number-list">
          {legacyPoolNumbers.map((item) => (
            <article key={item.id}>
              <header><div><strong>{item.e164Number}</strong><span>{item.provider} · {item.providerNumberId ?? 'Provider ID pending'}</span></div><span className={`platform-status platform-status--${item.status.toLowerCase()}`}>{title(item.status)}</span></header>
              <dl><div><dt>Customer</dt><dd>{item.organisationName ?? 'Unassigned'}</dd></div><div><dt>Pool verification</dt><dd>{item.providerVerifiedAt ? `Verified for automatic allocation · ${dateTime(item.providerVerifiedAt)}` : 'Not verified for automatic allocation'}</dd></div><div><dt>Ready at</dt><dd>{dateTime(item.readyAt)}</dd></div><div><dt>Cooling until</dt><dd>{dateTime(item.quarantineUntil)}</dd></div></dl>
              <div className="platform-number-actions">
                {item.status === 'AVAILABLE' && item.organisationId === null && item.providerVerifiedAt === null ? (
                  <form action={actions.verify as never}>
                    <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedUpdatedAt" value={item.updatedAt.toISOString()} /><input name="providerNumberId" defaultValue={item.providerNumberId ?? ''} placeholder="Verified Sinch provider ID" maxLength={128} required /><input name="reason" placeholder="Verification evidence / reason" maxLength={500} required />
                    <label className="platform-confirm"><input type="checkbox" name="verificationConfirmed" required />I confirmed ownership, outbound sending and inbound replies</label><small>Only verified pool numbers can be assigned automatically.</small><button className="button button--primary" type="submit">Verify for automatic allocation</button>
                  </form>
                ) : null}
                {item.status === 'AVAILABLE' || item.status === 'RELEASED' ? (
                  <form action={actions.assign as never}>
                    <input type="hidden" name="numberId" value={item.id} /><input type="hidden" name="expectedStatus" value={item.status} /><input type="hidden" name="expectedUpdatedAt" value={item.updatedAt.toISOString()} /><select name="organisationId" aria-label={`Customer for ${item.e164Number}`} required><option value="">Select customer</option>{organisations.map((organisation) => <option key={organisation.id} value={organisation.id}>{organisation.name}</option>)}</select><input name="reason" placeholder="Reason" maxLength={500} required /><button className="button button--primary" type="submit">Assign customer</button>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
        </div>
        {numberTotalPages > 1 ? (
          <nav className="platform-pagination" aria-label="SMS number pages">
            {page.page > 1 ? <Link href={numberPageHref(page.page - 1)}>← Previous</Link> : <span />}<span>Page {page.page} of {numberTotalPages}</span>{page.page < numberTotalPages ? <Link href={numberPageHref(page.page + 1)}>Next →</Link> : <span />}
          </nav>
        ) : null}
      </details>
    </div>
  );
}
