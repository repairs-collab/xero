import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import {
  contactChannels,
  contacts,
  disputes,
  invoiceChases,
  invoices,
  organisations,
  pauses,
  paymentPromises,
  PostgresActivityRepository,
  reminderSequences,
  reminderSequenceVersions,
  suppressions
} from '@bc5000/db/web';

import { CustomerTimeline } from '../../../../components/customer-timeline.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  addCustomerNote,
  clearApprovedPhoneOverride,
  pauseChasing,
  recordDispute,
  recordPromiseToPay,
  resumeChasing,
  sendManualReminder,
  setApprovedPhoneOverride
} from './actions.js';
import { createManualReminderView } from './manual-reminder-view.js';

const hidden = (organisationId: string, customerId: string) => (
  <>
    <input type="hidden" name="organisationId" value={organisationId} />
    <input type="hidden" name="customerId" value={customerId} />
  </>
);

export default async function CustomerPage({
  params
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (!organisationId) throw new Error('No active organisation membership');
  const db = getDatabaseClient().db;
  const [customer] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organisationId, organisationId),
        eq(contacts.id, customerId)
      )
    )
    .limit(1);
  if (!customer) notFound();

  const [
    channels,
    invoiceRows,
    openDisputes,
    promises,
    activity,
    organisation
  ] = await Promise.all([
    db
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.organisationId, organisationId),
          eq(contactChannels.contactId, customerId)
        )
      ),
    db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, organisationId),
          eq(invoices.contactId, customerId)
        )
      )
      .orderBy(desc(invoices.dueDate)),
    db
      .select()
      .from(disputes)
      .where(
        and(
          eq(disputes.organisationId, organisationId),
          eq(disputes.contactId, customerId),
          eq(disputes.status, 'OPEN')
        )
      ),
    db
      .select()
      .from(paymentPromises)
      .where(
        and(
          eq(paymentPromises.organisationId, organisationId),
          eq(paymentPromises.contactId, customerId),
          eq(paymentPromises.status, 'ACTIVE')
        )
      ),
    new PostgresActivityRepository(db).customerTimeline(
      organisationId,
      customerId
    ),
    db
      .select()
      .from(organisations)
      .where(eq(organisations.id, organisationId))
      .limit(1)
      .then((rows) => rows[0])
  ]);
  if (organisation === undefined) throw new Error('Organisation not found');

  const approvedPhone = channels.find(
    (channel) => channel.kind === 'SMS' && channel.approvedOverride
  );
  const usablePhone =
    approvedPhone ??
    channels.find((channel) => channel.kind === 'SMS' && channel.usable);
  const phone = usablePhone?.normalisedValue ?? null;
  const invoiceIds = invoiceRows.map((invoice) => invoice.id);
  const activeChases =
    invoiceIds.length === 0
      ? []
      : await db
          .select({
            invoiceId: invoiceChases.invoiceId,
            sequenceId: invoiceChases.sequenceId
          })
          .from(invoiceChases)
          .innerJoin(
            reminderSequences,
            and(
              eq(reminderSequences.id, invoiceChases.sequenceId),
              eq(reminderSequences.enabled, true)
            )
          )
          .innerJoin(
            reminderSequenceVersions,
            and(
              eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
              eq(reminderSequenceVersions.status, 'ACTIVE')
            )
          )
          .where(
            and(
              eq(invoiceChases.organisationId, organisationId),
              eq(invoiceChases.status, 'ACTIVE'),
              inArray(invoiceChases.invoiceId, invoiceIds)
            )
          );
  const sequenceIds = [...new Set(activeChases.map((chase) => chase.sequenceId))];
  const pauseScopes = [
    eq(pauses.contactId, customerId),
    ...(invoiceIds.length > 0 ? [inArray(pauses.invoiceId, invoiceIds)] : []),
    ...(sequenceIds.length > 0 ? [inArray(pauses.sequenceId, sequenceIds)] : [])
  ];
  const destinations = [phone, customer.email].filter(
    (value): value is string => value !== null
  );
  const [activePauses, activeSuppressions] = await Promise.all([
    db
      .select()
      .from(pauses)
      .where(
        and(
          eq(pauses.organisationId, organisationId),
          eq(pauses.active, true),
          or(isNull(pauses.expiresAt), gt(pauses.expiresAt, new Date())),
          or(...pauseScopes)
        )
      ),
    destinations.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(suppressions)
          .where(
            and(
              eq(suppressions.organisationId, organisationId),
              eq(suppressions.consentState, 'SUPPRESSED'),
              inArray(suppressions.normalisedDestination, destinations)
            )
          )
  ]);
  const isPaused = activePauses.length > 0;
  const hasActivePromise = promises.some((promise) => {
    const until = new Date(`${promise.promisedDate}T23:59:59.999Z`);
    until.setUTCDate(until.getUTCDate() + promise.graceDays);
    return until >= new Date();
  });

  return (
    <div className="page-stack">
      <a className="back-link" href="/customers">
        ← Back to customers
      </a>
      <header className="customer-hero">
        <div className="avatar avatar--hero">
          {customer.name.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <span className="eyebrow">Customer account</span>
          <h1>{customer.name}</h1>
          <p>
            {customer.email ?? 'No email'} · {phone ?? 'No mobile'}
          </p>
        </div>
        <div className={isPaused ? 'status-chip status-chip--paused' : 'status-chip'}>
          {isPaused ? 'Chasing paused' : 'Chasing active'}
        </div>
      </header>

      <div className="customer-layout">
        <main>
          <section className="panel">
            <div className="panel__heading">
              <div>
                <span className="eyebrow">Outstanding invoices</span>
                <h2>{invoiceRows.length} Xero invoices</h2>
              </div>
            </div>
            <div className="invoice-list invoice-list--actions">
              {invoiceRows.map((invoice) => {
                const activeChase = activeChases.find(
                  (chase) => chase.invoiceId === invoice.id
                );
                const activePause = activePauses.find(
                  (pause) =>
                    pause.scope === 'customer' ||
                    (pause.scope === 'invoice' && pause.invoiceId === invoice.id) ||
                    (pause.scope === 'sequence' &&
                      pause.sequenceId === activeChase?.sequenceId)
                );
                const openDispute = openDisputes.find(
                  (dispute) =>
                    dispute.invoiceId === null || dispute.invoiceId === invoice.id
                );
                const blockingReason =
                  activePause !== undefined
                    ? `Chasing is paused${activePause.reason ? `: ${activePause.reason}` : ''}`
                    : openDispute !== undefined
                      ? 'Resolve the open dispute before sending'
                      : hasActivePromise
                        ? 'Payment promise is still active'
                        : null;
                const view = createManualReminderView({
                  customerName: customer.name,
                  invoiceNumber: invoice.invoiceNumber,
                  amountDue: invoice.amountDue,
                  currency: invoice.currency,
                  dueDate: invoice.dueDate,
                  type: invoice.type,
                  status: invoice.status,
                  onlineInvoiceUrl: invoice.onlineInvoiceUrl,
                  email: customer.email,
                  phone,
                  chasingPaused: activePause !== undefined,
                  customerActive: customer.active,
                  hasActiveChase: activeChase !== undefined,
                  smsSuppressed: activeSuppressions.some(
                    (suppression) =>
                      suppression.channel === 'SMS' &&
                      suppression.normalisedDestination === phone
                  ),
                  emailSuppressed: activeSuppressions.some(
                    (suppression) =>
                      suppression.channel === 'XERO_EMAIL' &&
                      suppression.normalisedDestination.toLowerCase() ===
                        customer.email?.toLowerCase()
                  ),
                  sendMode: organisation.sendMode,
                  recipientAllowlist: organisation.recipientAllowlist,
                  blockingReason
                });
                return (
                  <article className="invoice-action-card" key={invoice.id}>
                    <div className="invoice-action-card__summary">
                      <div>
                        <strong>{invoice.invoiceNumber}</strong>
                        <span>
                          Due {invoice.dueDate} · {invoice.status}
                        </span>
                      </div>
                      <strong>
                        {new Intl.NumberFormat('en-AU', {
                          style: 'currency',
                          currency: invoice.currency
                        }).format(Number(invoice.amountDue))}
                      </strong>
                    </div>

                    <div className="invoice-action-card__buttons">
                      {view.call.available ? (
                        <a className="button" href={view.call.href}>
                          Call client
                        </a>
                      ) : (
                        <button className="button" disabled title="No usable phone number">
                          Call client
                        </button>
                      )}

                      {view.sms.available ? (
                        <details className="manual-reminder-form">
                          <summary className="button">Send SMS</summary>
                          <form action={sendManualReminder}>
                            {hidden(organisationId, customerId)}
                            <input type="hidden" name="invoiceId" value={invoice.id} />
                            <input type="hidden" name="channel" value="SMS" />
                            <input type="hidden" name="requestId" value={randomUUID()} />
                            <label>
                              Message
                              <textarea name="message" rows={4} defaultValue={view.sms.message} required />
                            </label>
                            <label className="manual-confirmation">
                              <input type="checkbox" name="confirmed" value="yes" required />
                              I confirm this SMS is ready to send
                            </label>
                            <button className="button button--primary">Confirm and send SMS</button>
                          </form>
                        </details>
                      ) : (
                        <button className="button" disabled title={view.sms.disabledReason ?? undefined}>
                          Send SMS
                        </button>
                      )}

                      {view.email.available ? (
                        <details className="manual-reminder-form">
                          <summary className="button">Send email</summary>
                          <form action={sendManualReminder}>
                            {hidden(organisationId, customerId)}
                            <input type="hidden" name="invoiceId" value={invoice.id} />
                            <input type="hidden" name="channel" value="XERO_EMAIL" />
                            <input type="hidden" name="requestId" value={randomUUID()} />
                            <p>Xero will email its current invoice and payment link to {customer.email}.</p>
                            <label className="manual-confirmation">
                              <input type="checkbox" name="confirmed" value="yes" required />
                              I confirm this Xero email is ready to send
                            </label>
                            <button className="button button--primary">Confirm and send email</button>
                          </form>
                        </details>
                      ) : (
                        <button className="button" disabled title={view.email.disabledReason ?? undefined}>
                          Send email
                        </button>
                      )}
                    </div>
                    {(!view.sms.available || !view.email.available) && (
                      <small className="invoice-action-card__hint">
                        {view.sms.disabledReason ?? view.email.disabledReason}
                      </small>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="panel timeline-panel">
            <div className="panel__heading">
              <div>
                <span className="eyebrow">Complete history</span>
                <h2>Timeline</h2>
              </div>
            </div>
            <CustomerTimeline
              events={activity.map((event) => ({
                ...event,
                occurredAt: event.occurredAt.toISOString()
              }))}
            />
          </section>
        </main>

        <aside className="customer-actions-panel">
          <section className="panel">
            <span className="eyebrow">Account controls</span>
            <details open>
              <summary>Add internal note</summary>
              <form action={addCustomerNote}>
                {hidden(organisationId, customerId)}
                <textarea name="note" rows={3} placeholder="Plain-text note" required />
                <button className="button button--primary">Add note</button>
              </form>
            </details>
            <details>
              <summary>Promise to pay</summary>
              <form action={recordPromiseToPay}>
                {hidden(organisationId, customerId)}
                <label>
                  Promised date
                  <input name="promisedDate" type="date" required />
                </label>
                <label>
                  Grace days
                  <input name="graceDays" type="number" min="0" max="30" defaultValue="2" required />
                </label>
                <button className="button button--primary">Record promise</button>
              </form>
            </details>
            <details>
              <summary>Record dispute</summary>
              <form action={recordDispute}>
                {hidden(organisationId, customerId)}
                <label>
                  Invoice
                  <select name="invoiceId">
                    <option value="">All invoices</option>
                    {invoiceRows.map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.invoiceNumber}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Reason
                  <textarea name="reason" rows={3} required />
                </label>
                <button className="button button--primary">Record and pause</button>
              </form>
            </details>
            <details>
              <summary>SMS phone override</summary>
              <form action={setApprovedPhoneOverride}>
                {hidden(organisationId, customerId)}
                <label>
                  Mobile
                  <input name="phone" type="tel" defaultValue={approvedPhone?.sourceValue} />
                </label>
                <label>
                  Reason
                  <input name="reason" required />
                </label>
                <button className="button button--primary">Approve override</button>
              </form>
              {approvedPhone && (
                <form action={clearApprovedPhoneOverride}>
                  {hidden(organisationId, customerId)}
                  <label>
                    Clear reason
                    <input name="reason" required />
                  </label>
                  <button className="button">Clear override</button>
                </form>
              )}
            </details>
            <details>
              <summary>{isPaused ? 'Resume chasing' : 'Pause chasing'}</summary>
              <form action={isPaused ? resumeChasing : pauseChasing}>
                {hidden(organisationId, customerId)}
                <label>
                  Reason
                  <textarea name="reason" rows={2} required />
                </label>
                <button className="button button--primary">
                  {isPaused ? 'Resume and recalculate' : 'Pause all chasing'}
                </button>
              </form>
            </details>
          </section>
          <section className="account-flags">
            {activePauses.map((pause) => (
              <div key={pause.id}>
                <strong>{pause.kind.replaceAll('_', ' ')}</strong>
                <span>{pause.reason}</span>
              </div>
            ))}
            {openDisputes.map((dispute) => (
              <div key={dispute.id}>
                <strong>Open dispute</strong>
                <span>{dispute.reason}</span>
              </div>
            ))}
            {promises.map((promise) => (
              <div key={promise.id}>
                <strong>Promise to pay</strong>
                <span>
                  {promise.promisedDate} + {promise.graceDays} grace days
                </span>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
