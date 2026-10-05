import { headers } from 'next/headers';
import Link from 'next/link';
import { ChevronRightIcon } from '@heroicons/react/24/outline';

import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';
import {
  getCustomerList,
  parseCustomerSort,
  type CustomerSortField
} from '../../../server/customer-list-service.js';

type SearchParameters = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function CustomersPage({ searchParams }: { searchParams: SearchParameters }) {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); const organisationId = session.memberships[0]?.organisationId; if (!organisationId) throw new Error('No active organisation membership');
  const parameters = await searchParams;
  const sorting = parseCustomerSort(first(parameters.sort), first(parameters.direction));
  const rows = await getCustomerList(getDatabaseClient().db, { organisationId, ...sorting });
  const sortLink = (field: CustomerSortField) => {
    const direction = sorting.sort === field && sorting.direction === 'asc' ? 'desc' : 'asc';
    return `/customers?sort=${field}&direction=${direction}`;
  };
  const marker = (field: CustomerSortField) => sorting.sort === field ? (sorting.direction === 'asc' ? ' ↑' : ' ↓') : '';
  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">Accounts receivable</span><h1>Customers</h1><p>See balances, pauses, contact details, and the complete chase history.</p></header><nav className="customer-sort-bar" aria-label="Sort customers"><Link href={sortLink('name')}>Customer{marker('name')}</Link><Link href={sortLink('email')}>Email{marker('email')}</Link><Link href={sortLink('invoices')}>Open invoices{marker('invoices')}</Link><Link href={sortLink('amount')}>Amount due{marker('amount')}</Link></nav><div className="customer-list">{rows.map(({ contact, invoiceCount, amountDue, currency }) => <Link href={`/customers/${contact.id}`} className="customer-row" key={contact.id}><div className="avatar avatar--light">{contact.name.slice(0,2).toUpperCase()}</div><div><strong>{contact.name}</strong><span>{contact.email ?? 'No email in Xero'}</span></div><div><small>Open invoices</small><strong>{invoiceCount}</strong></div><div><small>Amount due</small><strong>{new Intl.NumberFormat('en-AU', { style:'currency', currency }).format(Number(amountDue))}</strong></div><ChevronRightIcon className="chevron" aria-hidden="true" /></Link>)}</div></div>;
}
