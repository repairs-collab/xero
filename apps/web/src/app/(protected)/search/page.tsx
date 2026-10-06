import { headers } from 'next/headers';
import Link from 'next/link';

import { searchDirectory } from '../../../server/global-search-service.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

type SearchParameters = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function SearchPage({ searchParams }: { searchParams: SearchParameters }) {
  const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() }));
  const organisationId = session.memberships[0]?.organisationId;
  if (!organisationId) throw new Error('No active organisation membership');
  const query = (first((await searchParams).q) ?? '').trim().slice(0, 100);
  const results = await searchDirectory(getDatabaseClient().db, { organisationId, query });
  const total = results.customers.length + results.invoices.length;
  const money = (amount: string, currency: string) => new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(Number(amount));

  return <div className="page-stack"><header className="page-heading"><span className="eyebrow">AccountPulse search</span><h1>{query ? `Results for “${query}”` : 'Search accounts'}</h1><p>{query ? `${total} matching customers and invoices in this workspace.` : 'Use the search field above to find a customer, invoice number, or exact amount.'}</p></header>{query && total === 0 && <div className="empty-state"><span>0</span><h2>No matches found</h2><p>Check the spelling or try an invoice amount without cents.</p></div>}{results.customers.length > 0 && <section className="panel search-results"><div className="section-heading"><span className="eyebrow">Customers</span><h2>{results.customers.length} matches</h2></div>{results.customers.map((customer) => <Link href={`/customers/${customer.id}`} key={customer.id} className="search-result-row"><span><strong>{customer.name}</strong><small>{customer.email ?? 'No email in Xero'}</small></span><span>View customer →</span></Link>)}</section>}{results.invoices.length > 0 && <section className="panel search-results"><div className="section-heading"><span className="eyebrow">Invoices</span><h2>{results.invoices.length} matches</h2></div>{results.invoices.map((invoice) => <Link href={`/invoices/${invoice.id}`} key={invoice.id} className="search-result-row"><span><strong>{invoice.invoiceNumber}</strong><small>{invoice.customerName} · {invoice.status}</small></span><span><strong>{money(invoice.amountDue, invoice.currency)}</strong><small>View invoice →</small></span></Link>)}</section>}</div>;
}
