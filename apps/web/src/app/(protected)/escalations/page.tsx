import { randomUUID } from 'node:crypto';

import { CheckCircleIcon } from '@heroicons/react/24/outline';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';

import {
  contactChannels,
  contacts,
  invoiceChases,
  invoices,
  organisations,
  reminderSequenceVersions,
  reminderSequences,
  reminderWhitelistEntries,
  stageInstances,
  suppressions,
  tasks,
  users
} from '@bc5000/db/web';
import { selectPreferredSmsChannel } from '@bc5000/domain';

import { CallClientButton } from '../../../components/call-client-button.js';
import { ReminderWhitelistControls } from '../../../components/reminder-whitelist-controls.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import { createManualReminderView } from '../customers/[customerId]/manual-reminder-view.js';
import { addWhitelistEntry } from '../settings/reminder-whitelist/actions.js';
import { completeTask, sendEscalationSms } from './actions.js';

const formatDate = (value: Date): string =>
  new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium' }).format(value);

export default async function EscalationsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  const db = getDatabaseClient().db;
  const [organisation] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (organisation === undefined) throw new Error('Organisation not found');

  const rows = await db
    .select({ task: tasks, contact: contacts, invoice: invoices, assignee: users })
    .from(tasks)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, tasks.contactId),
        eq(contacts.organisationId, organisationId)
      )
    )
    .leftJoin(
      invoices,
      and(
        eq(invoices.id, tasks.invoiceId),
        eq(invoices.organisationId, organisationId)
      )
    )
    .leftJoin(users, eq(users.id, tasks.assignedUserId))
    .where(
      and(
        eq(tasks.organisationId, organisationId),
        eq(tasks.kind, 'DEBT_ESCALATION'),
        eq(tasks.status, 'OPEN')
      )
    )
    .orderBy(asc(tasks.dueAt));

  const contactIds = [...new Set(rows.map(({ contact }) => contact.id))];
  const invoiceIds = rows.flatMap(({ invoice }) =>
    invoice === null ? [] : [invoice.id]
  );
  const [channels, activeSuppressions, activeWhitelist, activeChases] =
    await Promise.all([
      contactIds.length === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(contactChannels)
            .where(
              and(
                eq(contactChannels.organisationId, organisationId),
                eq(contactChannels.kind, 'SMS'),
                eq(contactChannels.usable, true),
                inArray(contactChannels.contactId, contactIds)
              )
            ),
      db
        .select()
        .from(suppressions)
        .where(
          and(
            eq(suppressions.organisationId, organisationId),
            eq(suppressions.consentState, 'SUPPRESSED')
          )
        ),
      db
        .select()
        .from(reminderWhitelistEntries)
        .where(
          and(
            eq(reminderWhitelistEntries.organisationId, organisationId),
            isNull(reminderWhitelistEntries.removedAt)
          )
        ),
      invoiceIds.length === 0
        ? Promise.resolve([])
        : db
            .select({
              invoiceId: invoiceChases.invoiceId,
              sequenceId: invoiceChases.sequenceId
            })
            .from(invoiceChases)
            .innerJoin(
              reminderSequences,
              and(
                eq(reminderSequences.id, invoiceChases.sequenceId),
                eq(reminderSequences.organisationId, organisationId),
                eq(reminderSequences.enabled, true)
              )
            )
            .innerJoin(
              reminderSequenceVersions,
              and(
                eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
                eq(reminderSequenceVersions.organisationId, organisationId),
                eq(reminderSequenceVersions.status, 'ACTIVE')
              )
            )
            .where(
              and(
                eq(invoiceChases.organisationId, organisationId),
                eq(invoiceChases.status, 'ACTIVE'),
                inArray(invoiceChases.invoiceId, invoiceIds)
              )
            )
    ]);

  const models = await Promise.all(
    rows.map(async (row) => {
      const [version] = row.task.sequenceId
        ? await db
            .select()
            .from(reminderSequenceVersions)
            .where(
              and(
                eq(reminderSequenceVersions.organisationId, organisationId),
                eq(reminderSequenceVersions.sequenceId, row.task.sequenceId),
                eq(reminderSequenceVersions.status, 'ACTIVE')
              )
            )
            .limit(1)
        : [];
      const daily = row.task.sequenceId
        ? await db
            .select({ stage: stageInstances })
            .from(stageInstances)
            .innerJoin(
              invoiceChases,
              eq(invoiceChases.id, stageInstances.invoiceChaseId)
            )
            .where(
              and(
                eq(stageInstances.organisationId, organisationId),
                eq(invoiceChases.customerId, row.contact.id),
                eq(invoiceChases.sequenceId, row.task.sequenceId),
                eq(stageInstances.stageKey, 'daily-after-30'),
                inArray(stageInstances.status, [
                  'SCHEDULED',
                  'QUEUED',
                  'SENDING',
                  'SENT',
                  'DELIVERED',
                  'CANCELLED'
                ])
              )
            )
            .orderBy(desc(stageInstances.scheduledAt))
        : [];
      const phone = selectPreferredSmsChannel(
        channels.filter((channel) => channel.contactId === row.contact.id)
      )?.normalisedValue ?? null;
      const customerWhitelisted = activeWhitelist.some(
        (entry) => entry.scope === 'CLIENT' && entry.contactId === row.contact.id
      );
      const invoiceWhitelisted =
        row.invoice !== null &&
        activeWhitelist.some(
          (entry) =>
            entry.scope === 'INVOICE' && entry.invoiceId === row.invoice?.id
        );
      const whitelistReason = customerWhitelisted
        ? 'Reminders are stopped for this client'
        : invoiceWhitelisted
          ? 'Reminders are stopped for this invoice'
          : null;
      const reminderView =
        row.invoice === null
          ? null
          : createManualReminderView({
              customerName: row.contact.name,
              invoiceNumber: row.invoice.invoiceNumber,
              amountDue: row.invoice.amountDue,
              currency: row.invoice.currency,
              dueDate: row.invoice.dueDate,
              type: row.invoice.type,
              status: row.invoice.status,
              onlineInvoiceUrl: row.invoice.onlineInvoiceUrl,
              email: row.contact.email,
              phone,
              chasingPaused: false,
              customerActive: row.contact.active,
              hasActiveChase: activeChases.some(
                (chase) =>
                  chase.invoiceId === row.invoice?.id &&
                  chase.sequenceId === row.task.sequenceId
              ),
              smsSuppressed: activeSuppressions.some(
                (suppression) =>
                  suppression.channel === 'SMS' &&
                  suppression.normalisedDestination === phone
              ),
              emailSuppressed: false,
              sendMode: organisation.sendMode,
              liveSendAcknowledged: organisation.liveSendAcknowledged,
              rolloutScope: organisation.rolloutScope,
              maintenanceMode: organisation.maintenanceMode,
              recipientAllowlist: organisation.recipientAllowlist,
              blockingReason: whitelistReason
            });
      return {
        ...row,
        phone,
        reminderView,
        whitelistReason,
        basis: version?.dailyBasis ?? 'BUSINESS_DAYS',
        last:
          daily.find((item) =>
            ['SENT', 'DELIVERED'].includes(item.stage.status)
          )?.stage.completedAt ?? null,
        next:
          [...daily]
            .reverse()
            .find((item) => ['SCHEDULED', 'QUEUED'].includes(item.stage.status))
            ?.stage.scheduledAt ?? null,
        active: daily.some(
          (item) =>
            !['CANCELLED', 'FAILED', 'FAILED_PERMANENT'].includes(
              item.stage.status
            )
        )
      };
    })
  );

  return (
    <div className="page-stack">
      <header className="page-heading">
        <span className="eyebrow">30-day manual follow-up</span>
        <h1>Escalations</h1>
        <p>
          Call or message the client, then record the outcome. Completing a task
          does not stop daily SMS reminders.
        </p>
      </header>
      <div className="escalation-list">
        {models.length === 0 ? (
          <div className="empty-state">
            <span>
              <CheckCircleIcon aria-hidden="true" />
            </span>
            <h2>No open escalations</h2>
            <p>30-day accounts that need a person will appear here.</p>
          </div>
        ) : (
          models.map(
            ({
              task,
              contact,
              invoice,
              assignee,
              phone,
              reminderView,
              whitelistReason,
              basis,
              last,
              next,
              active
            }) => (
              <article className="escalation-card" key={task.id}>
                <div className="escalation-card__main">
                  <span className="mode-badge">
                    Due {task.dueAt ? formatDate(task.dueAt) : 'now'}
                  </span>
                  <h2>{contact.name}</h2>
                  <p>{task.summary}</p>
                  <div className="escalation-meta">
                    <span>
                      <small>Invoice</small>
                      <strong>{invoice?.invoiceNumber ?? 'Customer account'}</strong>
                    </span>
                    <span>
                      <small>Assigned</small>
                      <strong>{assignee?.displayName ?? 'Unassigned'}</strong>
                    </span>
                    <span>
                      <small>Daily SMS</small>
                      <strong>
                        {active ? 'Active' : 'Stopped'} ·{' '}
                        {basis === 'BUSINESS_DAYS'
                          ? 'Business days'
                          : 'Calendar days'}
                      </strong>
                    </span>
                    <span>
                      <small>Last / next</small>
                      <strong>
                        {last ? formatDate(last) : 'None'} /{' '}
                        {next ? formatDate(next) : 'Not scheduled'}
                      </strong>
                    </span>
                  </div>

                  <div className="escalation-contact-actions">
                    <Link className="button" href={`/customers/${contact.id}`}>
                      View client
                    </Link>
                    {invoice === null ? (
                      <button
                        className="button"
                        type="button"
                        disabled
                        title="No invoice is linked to this escalation"
                      >
                        View invoice
                      </button>
                    ) : (
                      <Link className="button" href={`/invoices/${invoice.id}`}>
                        View invoice
                      </Link>
                    )}
                    <CallClientButton
                      organisationId={organisationId}
                      taskId={task.id}
                      available={phone !== null}
                      disabledReason="No usable mobile number"
                    />

                    {invoice !== null && reminderView?.sms.available ? (
                      <details className="manual-reminder-form escalation-sms-form">
                        <summary className="button">Send SMS</summary>
                        <form action={sendEscalationSms}>
                          <input
                            type="hidden"
                            name="organisationId"
                            value={organisationId}
                          />
                          <input
                            type="hidden"
                            name="customerId"
                            value={contact.id}
                          />
                          <input
                            type="hidden"
                            name="invoiceId"
                            value={invoice.id}
                          />
                          <input
                            type="hidden"
                            name="requestId"
                            value={randomUUID()}
                          />
                          <label>
                            Message
                            <textarea
                              name="message"
                              rows={4}
                              defaultValue={reminderView.sms.message}
                              required
                            />
                          </label>
                          <p>
                            Keep the Xero payment link in the message so the
                            client can pay immediately.
                          </p>
                          <label className="manual-confirmation">
                            <input
                              type="checkbox"
                              name="confirmed"
                              value="yes"
                              required
                            />
                            I confirm this escalation SMS is ready to send
                          </label>
                          <button className="button button--primary">
                            Confirm and send SMS
                          </button>
                        </form>
                      </details>
                    ) : (
                      <span className="escalation-disabled-action">
                        <button
                          className="button"
                          type="button"
                          disabled
                          title={
                            reminderView?.sms.disabledReason ??
                            'No invoice is linked to this escalation'
                          }
                        >
                          Send SMS
                        </button>
                        <small>
                          {reminderView?.sms.disabledReason ??
                            'No invoice is linked to this escalation'}
                        </small>
                      </span>
                    )}
                  </div>

                  {phone === null && (
                    <small className="escalation-action-hint">
                      Calling is unavailable because this client has no usable
                      mobile number.
                    </small>
                  )}

                  {whitelistReason === null ? (
                    <ReminderWhitelistControls
                      organisationId={organisationId}
                      contactId={contact.id}
                      {...(invoice === null ? {} : { invoiceId: invoice.id })}
                      action={addWhitelistEntry}
                    />
                  ) : (
                    <div className="invoice-whitelist-banner">
                      <strong>{whitelistReason}</strong>
                      <span>
                        This escalation will disappear when the page refreshes.
                      </span>
                    </div>
                  )}
                </div>

                <form action={completeTask} className="task-complete-form">
                  <input
                    type="hidden"
                    name="organisationId"
                    value={organisationId}
                  />
                  <input type="hidden" name="taskId" value={task.id} />
                  <label>
                    Resolution note
                    <textarea
                      name="resolutionNote"
                      rows={3}
                      required
                      placeholder="What happened?"
                    />
                  </label>
                  <button className="button button--primary">
                    Complete task
                  </button>
                  <small>This does not stop messaging.</small>
                </form>
              </article>
            )
          )
        )}
      </div>
    </div>
  );
}
