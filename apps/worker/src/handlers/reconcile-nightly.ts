import { and, eq, gt } from 'drizzle-orm';

import { auditEvents, invoices } from '@bc5000/db';
import type { XeroInvoice } from '@bc5000/integrations/xero';
import type { JobPayloads } from '@bc5000/jobs';

import { recordSuccessfulSync, synchroniseInvoiceSnapshot, type XeroSyncDependencies } from './xero-invoice-refresh.js';

async function mapWithConcurrency<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) { const current = items[index]; index += 1; if (current !== undefined) await action(current); }
  });
  await Promise.all(workers);
}

const terminal = (invoice: XeroInvoice) => invoice.status === 'PAID' || invoice.status === 'VOIDED' || invoice.status === 'DELETED' || Number(invoice.amountDue) <= 0;

export async function reconcileNightly(dependencies: XeroSyncDependencies, payload: JobPayloads['xero.nightly-reconcile']) {
  const listed = await dependencies.xero.listOutstandingInvoices();
  const remoteIds = new Set(listed.data.map((invoice) => invoice.id));
  const localEligible = await dependencies.database.select({ xeroInvoiceId: invoices.xeroInvoiceId }).from(invoices).where(and(eq(invoices.organisationId, payload.organisationId), eq(invoices.type, 'ACCREC'), eq(invoices.status, 'AUTHORISED'), gt(invoices.amountDue, '0')));
  const missing = localEligible.filter((invoice) => !remoteIds.has(invoice.xeroInvoiceId));
  let upserted = 0; let confirmedTerminal = 0;
  await mapWithConcurrency(listed.data, 4, async (invoice) => { await synchroniseInvoiceSnapshot(dependencies, payload.organisationId, invoice); upserted += 1; });
  await mapWithConcurrency(missing, 4, async (local) => {
    const confirmed = await dependencies.xero.getInvoice(local.xeroInvoiceId);
    await synchroniseInvoiceSnapshot(dependencies, payload.organisationId, confirmed.data);
    upserted += 1; if (terminal(confirmed.data)) confirmedTerminal += 1;
  });
  await recordSuccessfulSync(dependencies, payload.organisationId);
  const summary = { remoteEligible: listed.data.length, localEligible: localEligible.length, missingLocally: listed.data.filter((invoice) => !localEligible.some((local) => local.xeroInvoiceId === invoice.id)).length, targetedConfirmations: missing.length, confirmedTerminal, upserted, apiHeadroom: listed.rateLimit.remaining };
  await dependencies.database.insert(auditEvents).values({ organisationId: payload.organisationId, eventType: 'XERO_RECONCILIATION_COMPLETED', entityType: 'ORGANISATION', entityId: payload.organisationId, afterValue: summary, occurredAt: dependencies.clock.now() });
  return summary;
}
