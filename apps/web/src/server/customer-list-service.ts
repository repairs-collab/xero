import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';

import {
  contacts,
  type Database,
  invoices,
  organisations
} from '@bc5000/db/web';

export type CustomerSortField = 'name' | 'email' | 'invoices' | 'amount';
export type SortDirection = 'asc' | 'desc';

const customerSortFields = new Set<CustomerSortField>([
  'name',
  'email',
  'invoices',
  'amount'
]);

export const parseCustomerSort = (
  rawSort: string | undefined,
  rawDirection: string | undefined
): { sort: CustomerSortField; direction: SortDirection } => ({
  sort: customerSortFields.has(rawSort as CustomerSortField)
    ? (rawSort as CustomerSortField)
    : 'name',
  direction: rawDirection === 'desc' ? 'desc' : 'asc'
});

export async function getCustomerList(
  database: Database,
  input: {
    organisationId: string;
    sort: CustomerSortField;
    direction: SortDirection;
  }
) {
  const [organisation] = await database
    .select({ baseCurrency: organisations.baseCurrency })
    .from(organisations)
    .where(eq(organisations.id, input.organisationId))
    .limit(1);
  if (!organisation) throw new Error('ORGANISATION_NOT_FOUND');
  const invoiceCount = count(invoices.id);
  const amountDue = sql<string>`coalesce(sum(${invoices.amountDue}), 0)`;
  const email = sql<string>`lower(coalesce(${contacts.email}, ''))`;
  const name = sql<string>`lower(${contacts.name})`;
  const sortExpression = {
    name,
    email,
    invoices: invoiceCount,
    amount: amountDue
  }[input.sort];
  const order = input.direction === 'desc' ? desc : asc;

  const rows = await database
    .select({ contact: contacts, invoiceCount, amountDue })
    .from(contacts)
    .leftJoin(
      invoices,
      and(
        eq(invoices.contactId, contacts.id),
        eq(invoices.organisationId, input.organisationId),
        eq(invoices.type, 'ACCREC'),
        eq(invoices.status, 'AUTHORISED'),
        eq(invoices.currency, organisation.baseCurrency),
        gt(invoices.amountDue, '0')
      )
    )
    .where(eq(contacts.organisationId, input.organisationId))
    .groupBy(contacts.id)
    .orderBy(order(sortExpression), asc(name), asc(contacts.id));
  return rows.map((row) => ({
    ...row,
    currency: organisation.baseCurrency
  }));
}
