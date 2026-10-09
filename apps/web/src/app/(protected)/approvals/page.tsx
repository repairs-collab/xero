import { and, asc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import {
  approvals,
  contactChannels,
  contacts,
  invoiceChases,
  invoices,
  stageInstances,
  voiceCallInvoices,
  voiceCallRequests
} from '@bc5000/db/web';

import {
  ApprovalTable,
  type ApprovalRow,
  type VoiceApprovalRow
} from '../../../components/approval-table.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../server/runtime.js';

const formatMoney = (value: string, currency: string) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(
    Number(value)
  );

const formatScheduledAt = (value: Date | null): string =>
  value === null
    ? 'Awaiting schedule'
    : new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Australia/Sydney'
      }).format(value);

const smsDetails = (content: string) => ({
  encoding: Array.from(content).some(
    (character) => character.codePointAt(0)! > 127
  )
    ? 'UCS-2'
    : 'GSM-7',
  segmentCount: Math.max(1, Math.ceil(content.length / 153))
});

const daysBetween = (later: Date, isoDate: string) =>
  Math.floor(
    (Date.UTC(
      later.getUTCFullYear(),
      later.getUTCMonth(),
      later.getUTCDate()
    ) -
      Date.parse(`${isoDate}T00:00:00.000Z`)) /
      86_400_000
  );

export default async function ApprovalsPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  const database = getDatabaseClient().db;
  const [messageData, voiceData] = await Promise.all([
    database
      .select({
        approval: approvals,
        stage: stageInstances,
        invoice: invoices,
        contact: contacts,
        channelValue: contactChannels.normalisedValue
      })
      .from(approvals)
      .innerJoin(stageInstances, eq(stageInstances.id, approvals.stageInstanceId))
      .innerJoin(
        invoiceChases,
        eq(invoiceChases.id, stageInstances.invoiceChaseId)
      )
      .innerJoin(invoices, eq(invoices.id, invoiceChases.invoiceId))
      .innerJoin(contacts, eq(contacts.id, invoices.contactId))
      .leftJoin(
        contactChannels,
        and(
          eq(contactChannels.contactId, contacts.id),
          eq(contactChannels.kind, 'SMS'),
          eq(contactChannels.usable, true)
        )
      )
      .where(
        and(
          eq(approvals.organisationId, organisationId),
          eq(approvals.status, 'PENDING')
        )
      )
      .orderBy(asc(stageInstances.scheduledAt)),
    database
      .select({
        call: voiceCallRequests,
        contact: contacts,
        invoice: voiceCallInvoices
      })
      .from(voiceCallRequests)
      .innerJoin(contacts, eq(contacts.id, voiceCallRequests.contactId))
      .innerJoin(
        voiceCallInvoices,
        and(
          eq(voiceCallInvoices.voiceCallId, voiceCallRequests.id),
          eq(
            voiceCallInvoices.organisationId,
            voiceCallRequests.organisationId
          )
        )
      )
      .where(
        and(
          eq(voiceCallRequests.organisationId, organisationId),
          eq(voiceCallRequests.source, 'SEQUENCE_REVIEW'),
          eq(voiceCallRequests.state, 'DRAFT')
        )
      )
      .orderBy(
        asc(voiceCallRequests.scheduledAt),
        asc(voiceCallInvoices.invoiceNumber)
      )
  ]);

  const now = new Date();
  const messageRows: ApprovalRow[] = messageData.map(
    ({ approval, stage, invoice, contact, channelValue }) => ({
      kind: 'MESSAGE',
      id: approval.id,
      organisationId,
      contactId: contact.id,
      invoiceId: invoice.id,
      customer: contact.name,
      invoiceNumber: invoice.invoiceNumber,
      amount: formatMoney(invoice.amountDue, invoice.currency),
      ageDays: Math.max(0, daysBetween(now, invoice.dueDate)),
      stage: stage.stageKey,
      channel: stage.channel,
      destination: channelValue ?? 'No usable mobile number',
      content: approval.renderedPreview,
      ...smsDetails(approval.renderedPreview),
      sourceVersion: approval.sourceVersion,
      eligibility:
        'Authorised, unpaid, above the minimum balance, and not paused'
    })
  );

  const groupedVoiceRows = new Map<string, VoiceApprovalRow>();
  for (const { call, contact, invoice } of voiceData) {
    const row = groupedVoiceRows.get(call.id) ?? {
      kind: 'VOICE' as const,
      id: call.id,
      organisationId,
      contactId: contact.id,
      customer: contact.name,
      stage: call.stageKey ?? 'voice-reminder',
      destination: call.destinationNumber,
      eligibility: 'Current voice facts will be verified again before calling',
      combinedAmount: formatMoney(call.combinedAmount, call.currency),
      scheduledAt: formatScheduledAt(call.scheduledAt),
      invoices: []
    };
    row.invoices.push({
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      amount: formatMoney(invoice.amountDue, invoice.currency)
    });
    groupedVoiceRows.set(call.id, row);
  }

  return (
    <div className="page-stack">
      <header className="page-heading page-heading--split">
        <div>
          <span className="eyebrow">Review queue</span>
          <h1>Approvals</h1>
          <p>See exactly what will happen before each reminder is released.</p>
        </div>
      </header>
      <section className="filter-bar" aria-label="Approval filters">
        <label>
          Stage
          <select defaultValue="all">
            <option value="all">All stages</option>
            <option>Due date</option>
            <option>7 days</option>
            <option>21 days</option>
            <option>30 days</option>
          </select>
        </label>
        <label>
          Channel
          <select defaultValue="all">
            <option value="all">All channels</option>
            <option>SMS</option>
            <option>Xero email</option>
            <option>Voice call</option>
          </select>
        </label>
        <label>
          Customer
          <input type="search" placeholder="Search customer" />
        </label>
        <label>
          Age
          <select defaultValue="all">
            <option value="all">Any age</option>
            <option>0–7 days</option>
            <option>8–21 days</option>
            <option>22+ days</option>
          </select>
        </label>
      </section>
      <ApprovalTable
        rows={[...messageRows, ...groupedVoiceRows.values()]}
      />
    </div>
  );
}
