import { and, desc, eq, isNull, or } from 'drizzle-orm';

import {
  contacts,
  type Database,
  invoiceChases,
  invoices,
  outboundMessages,
  reminderSequences,
  reminderWhitelistEntries
} from '@bc5000/db/web';

export interface InvoiceDetailsInput {
  organisationId: string;
  invoiceId: string;
}

export async function loadInvoiceDetails(
  database: Database,
  input: InvoiceDetailsInput
) {
  const [target] = await database
    .select({ invoice: invoices, contact: contacts })
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
        eq(invoices.id, input.invoiceId)
      )
    )
    .limit(1);
  if (target === undefined) return null;

  const [chases, whitelistEntries, messages] = await Promise.all([
    database
      .select({ chase: invoiceChases, sequenceName: reminderSequences.name })
      .from(invoiceChases)
      .innerJoin(
        reminderSequences,
        and(
          eq(reminderSequences.id, invoiceChases.sequenceId),
          eq(reminderSequences.organisationId, input.organisationId)
        )
      )
      .where(
        and(
          eq(invoiceChases.organisationId, input.organisationId),
          eq(invoiceChases.invoiceId, input.invoiceId)
        )
      )
      .orderBy(desc(invoiceChases.startedAt)),
    database
      .select()
      .from(reminderWhitelistEntries)
      .where(
        and(
          eq(reminderWhitelistEntries.organisationId, input.organisationId),
          isNull(reminderWhitelistEntries.removedAt),
          or(
            and(
              eq(reminderWhitelistEntries.scope, 'CLIENT'),
              eq(reminderWhitelistEntries.contactId, target.contact.id)
            ),
            and(
              eq(reminderWhitelistEntries.scope, 'INVOICE'),
              eq(reminderWhitelistEntries.invoiceId, input.invoiceId)
            )
          )
        )
      )
      .orderBy(desc(reminderWhitelistEntries.createdAt)),
    database
      .select({
        id: outboundMessages.id,
        channel: outboundMessages.channel,
        source: outboundMessages.source,
        recipient: outboundMessages.recipientKey,
        content: outboundMessages.content,
        status: outboundMessages.status,
        failureReason: outboundMessages.failureReason,
        createdAt: outboundMessages.createdAt,
        completedAt: outboundMessages.completedAt
      })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.organisationId, input.organisationId),
          eq(outboundMessages.invoiceId, input.invoiceId)
        )
      )
      .orderBy(desc(outboundMessages.createdAt), desc(outboundMessages.id))
      .limit(100)
  ]);

  return {
    invoice: target.invoice,
    contact: target.contact,
    chases,
    whitelistEntries,
    messages
  };
}

export type InvoiceDetailsModel = NonNullable<
  Awaited<ReturnType<typeof loadInvoiceDetails>>
>;
