import { and, eq, gt, inArray } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  contactChannels,
  contacts,
  type Database,
  invoiceChases,
  invoices,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages,
  suppressions
} from '@bc5000/db/web';
import { selectPreferredSmsChannel } from '@bc5000/domain';

export interface SmsIssueInvoice {
  id: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  dueDate: string;
}

export interface SmsIssueCustomer {
  customerId: string;
  customerName: string;
  email: string | null;
  reason: 'NO_USABLE_MOBILE' | 'SMS_SUPPRESSED';
  destination: string | null;
  invoices: SmsIssueInvoice[];
}

export interface SmsIssueSections {
  contactDetailsNeeded: SmsIssueCustomer[];
  complianceBlocked: SmsIssueCustomer[];
}

export function createSmsIssueService(dependencies: { database: Database }) {
  const list = async (
    session: AppSession,
    input: { organisationId: string }
  ): Promise<SmsIssueSections> => {
    authorise(session, 'chase.operate', input.organisationId);
    const rows = await dependencies.database
      .select({
        customerId: contacts.id,
        customerName: contacts.name,
        email: contacts.email,
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        amountDue: invoices.amountDue,
        currency: invoices.currency,
        dueDate: invoices.dueDate
      })
      .from(invoiceChases)
      .innerJoin(
        invoices,
        and(
          eq(invoices.id, invoiceChases.invoiceId),
          eq(invoices.organisationId, input.organisationId)
        )
      )
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, invoices.contactId),
          eq(contacts.organisationId, input.organisationId),
          eq(contacts.active, true)
        )
      )
      .innerJoin(
        reminderSequences,
        and(
          eq(reminderSequences.id, invoiceChases.sequenceId),
          eq(reminderSequences.organisationId, input.organisationId),
          eq(reminderSequences.enabled, true)
        )
      )
      .innerJoin(
        reminderSequenceVersions,
        and(
          eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
          eq(reminderSequenceVersions.organisationId, input.organisationId),
          eq(reminderSequenceVersions.status, 'ACTIVE')
        )
      )
      .innerJoin(
        sequenceStages,
        and(
          eq(sequenceStages.sequenceVersionId, reminderSequenceVersions.id),
          eq(sequenceStages.organisationId, input.organisationId),
          eq(sequenceStages.enabled, true),
          inArray(sequenceStages.channel, ['SMS', 'SMS_DAILY'])
        )
      )
      .where(
        and(
          eq(invoiceChases.organisationId, input.organisationId),
          eq(invoiceChases.status, 'ACTIVE'),
          eq(invoices.type, 'ACCREC'),
          eq(invoices.status, 'AUTHORISED'),
          gt(invoices.amountDue, '0')
        )
      );

    const customers = new Map<
      string,
      Omit<SmsIssueCustomer, 'reason' | 'destination'> & {
        invoicesById: Map<string, SmsIssueInvoice>;
      }
    >();
    for (const row of rows) {
      const existing = customers.get(row.customerId) ?? {
        customerId: row.customerId,
        customerName: row.customerName,
        email: row.email,
        invoices: [],
        invoicesById: new Map<string, SmsIssueInvoice>()
      };
      existing.invoicesById.set(row.invoiceId, {
        id: row.invoiceId,
        invoiceNumber: row.invoiceNumber,
        amountDue: row.amountDue,
        currency: row.currency,
        dueDate: row.dueDate
      });
      customers.set(row.customerId, existing);
    }
    const customerIds = [...customers.keys()];
    if (customerIds.length === 0) {
      return { contactDetailsNeeded: [], complianceBlocked: [] };
    }
    const [channels, blockedDestinations] = await Promise.all([
      dependencies.database
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.organisationId, input.organisationId),
            eq(contactChannels.kind, 'SMS'),
            eq(contactChannels.usable, true),
            inArray(contactChannels.contactId, customerIds)
          )
        ),
      dependencies.database
        .select({ destination: suppressions.normalisedDestination })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.organisationId, input.organisationId),
            eq(suppressions.channel, 'SMS'),
            eq(suppressions.consentState, 'SUPPRESSED')
          )
        )
    ]);
    const channelsByCustomer = Map.groupBy(
      channels,
      (channel) => channel.contactId
    );
    const suppressed = new Set(
      blockedDestinations.map(({ destination }) => destination)
    );
    const contactDetailsNeeded: SmsIssueCustomer[] = [];
    const complianceBlocked: SmsIssueCustomer[] = [];
    for (const customer of customers.values()) {
      const selected = selectPreferredSmsChannel(
        channelsByCustomer.get(customer.customerId) ?? []
      );
      const base = {
        customerId: customer.customerId,
        customerName: customer.customerName,
        email: customer.email,
        invoices: [...customer.invoicesById.values()].sort((left, right) =>
          left.invoiceNumber.localeCompare(right.invoiceNumber, 'en-AU')
        )
      };
      if (selected === undefined) {
        contactDetailsNeeded.push({
          ...base,
          reason: 'NO_USABLE_MOBILE',
          destination: null
        });
      } else if (suppressed.has(selected.normalisedValue)) {
        complianceBlocked.push({
          ...base,
          reason: 'SMS_SUPPRESSED',
          destination: selected.normalisedValue
        });
      }
    }
    const byName = (left: SmsIssueCustomer, right: SmsIssueCustomer) =>
      left.customerName.localeCompare(right.customerName, 'en-AU');
    return {
      contactDetailsNeeded: contactDetailsNeeded.sort(byName),
      complianceBlocked: complianceBlocked.sort(byName)
    };
  };

  return { list };
}
