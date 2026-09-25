import { randomUUID } from 'node:crypto';

import type { Database } from '@bc5000/db';
import {
  approvals,
  contactChannels,
  contacts,
  invoiceChases,
  invoices,
  organisations,
  stageInstances,
  tasks
} from '@bc5000/db';
import type {
  ListOutstandingInvoicesOptions,
  XeroContact,
  XeroInvoice,
  XeroResult
} from '@bc5000/integrations/xero';
import type { XeroInvoiceRefreshJob } from '@bc5000/jobs';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface SyncClock {
  now(): Date;
}

export interface XeroSyncClient {
  listOutstandingInvoices(
    options?: ListOutstandingInvoicesOptions
  ): Promise<XeroResult<XeroInvoice[]>>;
  getInvoice(invoiceId: string): Promise<XeroResult<XeroInvoice>>;
  getContact(contactId: string): Promise<XeroResult<XeroContact>>;
  listContacts(contactIds: string[]): Promise<XeroResult<XeroContact[]>>;
  getOnlineInvoiceUrl(
    invoiceId: string
  ): Promise<XeroResult<string>>;
}

export interface XeroSyncDependencies {
  database: Database;
  xero: XeroSyncClient;
  clock: SyncClock;
}

const money = (value: string): string => new Decimal(value).toFixed(4);

const normalisePhone = (value: string): string | null => {
  const parsed = parsePhoneNumberFromString(value, 'AU');
  return parsed?.isValid() === true ? parsed.format('E.164') : null;
};

const selectXeroPhone = (
  contact: XeroContact
): { source: string; normalised: string } | null => {
  const candidate =
    contact.phoneCandidates.find((phone) => phone.type === 'MOBILE') ??
    contact.phoneCandidates.find((phone) => phone.type === 'DEFAULT');
  if (candidate === undefined) return null;
  const normalised = normalisePhone(candidate.number);
  return normalised === null
    ? null
    : { source: candidate.number, normalised };
};

const invoiceChanged = (
  existing: typeof invoices.$inferSelect | undefined,
  invoice: XeroInvoice,
  contactId: string,
  onlineInvoiceUrl: string | null
): boolean =>
  existing === undefined ||
  existing.contactId !== contactId ||
  existing.invoiceNumber !== invoice.invoiceNumber ||
  existing.type !== invoice.type ||
  existing.status !== invoice.status ||
  existing.issueDate !== invoice.issueDate ||
  existing.dueDate !== invoice.dueDate ||
  existing.amountDue !== money(invoice.amountDue) ||
  existing.currency !== invoice.currency ||
  existing.onlineInvoiceUrl !== onlineInvoiceUrl ||
  (existing.xeroUpdatedAt?.toISOString() ?? null) !== invoice.updatedAt;

const terminalReason = (
  invoice: XeroInvoice
): 'XERO_PAID' | 'XERO_VOIDED' | 'XERO_DELETED' | null => {
  if (invoice.status === 'PAID' || new Decimal(invoice.amountDue).lte(0)) {
    return 'XERO_PAID';
  }
  if (invoice.status === 'VOIDED') return 'XERO_VOIDED';
  if (invoice.status === 'DELETED') return 'XERO_DELETED';
  return null;
};

export async function synchroniseInvoiceSnapshot(
  dependencies: XeroSyncDependencies,
  organisationId: string,
  invoice: XeroInvoice,
  preloadedContact?: XeroContact
): Promise<void> {
  const contact =
    preloadedContact ??
    (await dependencies.xero.getContact(invoice.contactId)).data;
  const onlineInvoiceUrl =
    invoice.status === 'AUTHORISED' &&
    new Decimal(invoice.amountDue).greaterThan(0)
      ? (await dependencies.xero.getOnlineInvoiceUrl(invoice.id)).data
      : null;
  const now = dependencies.clock.now();

  await dependencies.database.transaction(async (transaction) => {
    const existingContacts = await transaction
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organisationId, organisationId),
          eq(contacts.xeroContactId, contact.id)
        )
      )
      .limit(1);
    const existingContact = existingContacts[0];
    const contactId = existingContact?.id ?? randomUUID();

    await transaction
      .insert(contacts)
      .values({
        id: contactId,
        organisationId,
        xeroContactId: contact.id,
        name: contact.name,
        active: contact.active,
        email: contact.email,
        sourceVersion: (existingContact?.sourceVersion ?? 0) + 1,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [contacts.organisationId, contacts.xeroContactId],
        set: {
          name: contact.name,
          active: contact.active,
          email: contact.email,
          sourceVersion: (existingContact?.sourceVersion ?? 0) + 1,
          updatedAt: now
        }
      });

    const approvedOverrides = await transaction
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.organisationId, organisationId),
          eq(contactChannels.contactId, contactId),
          eq(contactChannels.kind, 'SMS'),
          eq(contactChannels.approvedOverride, true),
          eq(contactChannels.usable, true)
        )
      )
      .orderBy(desc(contactChannels.approvedAt))
      .limit(1);
    const approvedOverride = approvedOverrides[0];
    const approvedNormalised =
      approvedOverride === undefined
        ? null
        : normalisePhone(approvedOverride.normalisedValue);
    const selectedXeroPhone =
      approvedNormalised === null
        ? selectXeroPhone(contact)
        : null;

    await transaction
      .delete(contactChannels)
      .where(
        and(
          eq(contactChannels.organisationId, organisationId),
          eq(contactChannels.contactId, contactId),
          eq(contactChannels.kind, 'SMS'),
          eq(contactChannels.approvedOverride, false)
        )
      );

    if (approvedNormalised === null && selectedXeroPhone !== null) {
      await transaction.insert(contactChannels).values({
        organisationId,
        contactId,
        kind: 'SMS',
        sourceValue: selectedXeroPhone.source,
        normalisedValue: selectedXeroPhone.normalised,
        usable: true,
        approvedOverride: false,
        updatedAt: now
      });
    }

    if (approvedNormalised === null && selectedXeroPhone === null) {
      const existingTasks = await transaction
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.organisationId, organisationId),
            eq(tasks.contactId, contactId),
            eq(tasks.kind, 'DATA_QUALITY_PHONE'),
            eq(tasks.status, 'OPEN')
          )
        )
        .limit(1);
      if (existingTasks.length === 0) {
        await transaction.insert(tasks).values({
          organisationId,
          contactId,
          kind: 'DATA_QUALITY_PHONE',
          status: 'OPEN',
          summary: 'No unambiguous SMS phone number is available',
          updatedAt: now
        });
      }
    }

    const existingInvoices = await transaction
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, organisationId),
          eq(invoices.xeroInvoiceId, invoice.id)
        )
      )
      .limit(1);
    const existingInvoice = existingInvoices[0];
    const changed = invoiceChanged(
      existingInvoice,
      invoice,
      contactId,
      onlineInvoiceUrl
    );
    const invoiceId = existingInvoice?.id ?? randomUUID();
    const syncVersion =
      (existingInvoice?.syncVersion ?? 0) + (changed ? 1 : 0);
    const terminal = terminalReason(invoice);
    const values = {
      organisationId,
      xeroInvoiceId: invoice.id,
      contactId,
      invoiceNumber: invoice.invoiceNumber,
      type: invoice.type,
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      amountDue: money(invoice.amountDue),
      currency: invoice.currency,
      onlineInvoiceUrl,
      syncVersion,
      xeroUpdatedAt:
        invoice.updatedAt === null ? null : new Date(invoice.updatedAt),
      resolvedAt: terminal === null ? null : now,
      updatedAt: now
    };

    await transaction
      .insert(invoices)
      .values({ id: invoiceId, ...values })
      .onConflictDoUpdate({
        target: [invoices.organisationId, invoices.xeroInvoiceId],
        set: values
      });

    if (changed && existingInvoice !== undefined) {
      await transaction
        .update(approvals)
        .set({ status: 'EXPIRED' })
        .where(
          and(
            eq(approvals.organisationId, organisationId),
            inArray(approvals.status, ['PENDING', 'APPROVED']),
            sql`${approvals.stageInstanceId} in (
              select ${stageInstances.id}
              from ${stageInstances}
              inner join ${invoiceChases}
                on ${invoiceChases.id} = ${stageInstances.invoiceChaseId}
              where ${invoiceChases.invoiceId} = ${invoiceId}
            )`
          )
        );
      await transaction
        .update(stageInstances)
        .set({ status: 'CANCELLED', updatedAt: now })
        .where(
          and(
            eq(stageInstances.organisationId, organisationId),
            inArray(stageInstances.status, [
              'SCHEDULED',
              'DUE',
              'PENDING_APPROVAL',
              'QUEUED'
            ]),
            sql`${stageInstances.invoiceChaseId} in (
              select ${invoiceChases.id}
              from ${invoiceChases}
              where ${invoiceChases.invoiceId} = ${invoiceId}
            )`
          )
        );
    }

    if (terminal !== null) {
      await transaction
        .update(invoiceChases)
        .set({
          status: 'CLOSED',
          closedReason: terminal,
          closedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(invoiceChases.organisationId, organisationId),
            eq(invoiceChases.invoiceId, invoiceId),
            inArray(invoiceChases.status, ['ACTIVE', 'PAUSED'])
          )
        );
    }
  });
}

export async function synchroniseInvoiceCollection(
  dependencies: XeroSyncDependencies,
  organisationId: string,
  invoiceSnapshots: XeroInvoice[]
): Promise<void> {
  const contactIds = [
    ...new Set(invoiceSnapshots.map((invoice) => invoice.contactId))
  ];
  const contactResult = await dependencies.xero.listContacts(contactIds);
  const contactsById = new Map(
    contactResult.data.map((contact) => [contact.id, contact])
  );

  for (const invoice of invoiceSnapshots) {
    const contact = contactsById.get(invoice.contactId);
    if (contact === undefined) {
      throw new Error(`Xero contact was not returned for invoice ${invoice.id}`);
    }
    await synchroniseInvoiceSnapshot(
      dependencies,
      organisationId,
      invoice,
      contact
    );
  }
}

export async function runInvoiceRefresh(
  dependencies: XeroSyncDependencies,
  payload: XeroInvoiceRefreshJob
): Promise<void> {
  const invoice = await dependencies.xero.getInvoice(payload.invoiceId);
  await synchroniseInvoiceSnapshot(
    dependencies,
    payload.organisationId,
    invoice.data
  );
}

export const recordSuccessfulSync = async (
  dependencies: XeroSyncDependencies,
  organisationId: string
): Promise<void> => {
  const now = dependencies.clock.now();
  await dependencies.database
    .update(organisations)
    .set({
      xeroSyncCursor: now.toISOString(),
      lastSuccessfulSyncAt: now,
      updatedAt: now
    })
    .where(eq(organisations.id, organisationId));
};
