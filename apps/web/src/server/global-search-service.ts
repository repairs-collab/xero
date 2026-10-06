import { and, asc, eq, or, sql } from 'drizzle-orm';

import {
  contacts,
  type Database,
  invoices
} from '@bc5000/db/web';

export const normaliseSearchAmount = (rawValue: string): string | null => {
  const compact = rawValue.trim().replace(/[$,\s]/g, '');
  const match = /^(\d{1,15})(?:\.(\d{1,4}))?$/.exec(compact);
  if (!match) return null;
  return `${match[1]}.${(match[2] ?? '').padEnd(4, '0')}`;
};

export async function searchDirectory(
  database: Database,
  input: { organisationId: string; query: string; limit?: number }
) {
  const query = input.query.trim().slice(0, 100);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  if (query === '') return { customers: [], invoices: [] };
  const amount = normaliseSearchAmount(query);
  const customerNameMatches = sql<boolean>`position(lower(${query}) in lower(${contacts.name})) > 0`;
  const invoiceNumberMatches = sql<boolean>`position(lower(${query}) in lower(${invoices.invoiceNumber})) > 0`;

  const customerResults = await database
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.organisationId, input.organisationId),
        customerNameMatches
      )
    )
    .orderBy(asc(contacts.name), asc(contacts.id))
    .limit(limit);

  const invoiceMatch = or(
    invoiceNumberMatches,
    customerNameMatches,
    ...(amount === null ? [] : [eq(invoices.amountDue, amount)])
  );
  const invoiceResults = await database
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      amountDue: invoices.amountDue,
      currency: invoices.currency,
      status: invoices.status,
      customerId: contacts.id,
      customerName: contacts.name
    })
    .from(invoices)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, invoices.contactId),
        eq(contacts.organisationId, input.organisationId)
      )
    )
    .where(
      and(
        eq(invoices.organisationId, input.organisationId),
        eq(invoices.type, 'ACCREC'),
        invoiceMatch
      )
    )
    .orderBy(asc(invoices.invoiceNumber), asc(invoices.id))
    .limit(limit);

  return { customers: customerResults, invoices: invoiceResults };
}
