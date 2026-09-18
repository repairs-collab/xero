import { and, asc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { approvals, contactChannels, contacts, invoiceChases, invoices, stageInstances } from '@bc5000/db/web';

import { ApprovalTable, type ApprovalRow } from '../../../components/approval-table.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

const formatMoney = (value: string, currency: string) => new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(Number(value));
const smsDetails = (content: string) => ({ encoding: Array.from(content).some((character) => character.codePointAt(0)! > 127) ? 'UCS-2' : 'GSM-7', segmentCount: Math.max(1, Math.ceil(content.length / 153)) });
const daysBetween = (later: Date, isoDate: string) => Math.floor((Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate()) - Date.parse(`${isoDate}T00:00:00.000Z`)) / 86_400_000);

export default async function ApprovalsPage() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) throw new Error('No active organisation membership');
  const data = await getDatabaseClient().db.select({ approval: approvals, stage: stageInstances, invoice: invoices, contact: contacts, channelValue: contactChannels.normalisedValue }).from(approvals).innerJoin(stageInstances, eq(stageInstances.id, approvals.stageInstanceId)).innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId)).innerJoin(invoices, eq(invoices.id, invoiceChases.invoiceId)).innerJoin(contacts, eq(contacts.id, invoices.contactId)).leftJoin(contactChannels, and(eq(contactChannels.contactId, contacts.id), eq(contactChannels.kind, 'SMS'), eq(contactChannels.usable, true))).where(and(eq(approvals.organisationId, organisationId), eq(approvals.status, 'PENDING'))).orderBy(asc(stageInstances.scheduledAt));
  const now = new Date();
  const rows: ApprovalRow[] = data.map(({ approval, stage, invoice, contact, channelValue }) => ({ id: approval.id, organisationId, customer: contact.name, invoiceNumber: invoice.invoiceNumber, amount: formatMoney(invoice.amountDue, invoice.currency), ageDays: Math.max(0, daysBetween(now, invoice.dueDate)), stage: stage.stageKey, channel: stage.channel, destination: channelValue ?? 'No usable mobile number', content: approval.renderedPreview, ...smsDetails(approval.renderedPreview), sourceVersion: approval.sourceVersion, eligibility: 'Authorised, unpaid, above the minimum balance, and not paused' }));
  return <div className="page-stack"><header className="page-heading page-heading--split"><div><span className="eyebrow">Review queue</span><h1>Approvals</h1><p>See exactly what will happen before each reminder is released.</p></div></header><section className="filter-bar" aria-label="Approval filters"><label>Stage<select defaultValue="all"><option value="all">All stages</option><option>Due date</option><option>7 days</option><option>21 days</option><option>30 days</option></select></label><label>Channel<select defaultValue="all"><option value="all">All channels</option><option>SMS</option><option>Xero email</option></select></label><label>Customer<input type="search" placeholder="Search customer" /></label><label>Age<select defaultValue="all"><option value="all">Any age</option><option>0–7 days</option><option>8–21 days</option><option>22+ days</option></select></label></section><ApprovalTable rows={rows} /></div>;
}
