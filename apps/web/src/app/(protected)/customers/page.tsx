import { and, count, eq, gt, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';

import { contacts, invoices } from '@bc5000/db/web';

import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

export default async function CustomersPage() {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); const organisationId = session.memberships[0]?.organisationId; if (!organisationId) throw new Error('No active organisation membership');
  const rows = await getDatabaseClient().db.select({ contact: contacts, invoiceCount: count(invoices.id), amountDue: sql<string>`coalesce(sum(${invoices.amountDue}), 0)` }).from(contacts).leftJoin(invoices, and(eq(invoices.contactId, contacts.id), eq(invoices.status, 'AUTHORISED'), gt(invoices.amountDue, '0'))).where(eq(contacts.organisationId, organisationId)).groupBy(contacts.id).orderBy(contacts.name);
  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">Accounts receivable</span><h1>Customers</h1><p>See balances, pauses, contact details, and the complete chase history.</p></header><div className="customer-list">{rows.map(({ contact, invoiceCount, amountDue }) => <Link href={`/customers/${contact.id}`} className="customer-row" key={contact.id}><div className="avatar avatar--light">{contact.name.slice(0,2).toUpperCase()}</div><div><strong>{contact.name}</strong><span>{contact.email ?? 'No email in Xero'}</span></div><div><small>Open invoices</small><strong>{invoiceCount}</strong></div><div><small>Amount due</small><strong>{new Intl.NumberFormat('en-AU', { style:'currency', currency:'AUD' }).format(Number(amountDue))}</strong></div><span className="chevron">›</span></Link>)}</div></div>;
}
