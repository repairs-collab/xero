import { and, eq, gt } from 'drizzle-orm';

import { invoices } from '@bc5000/db';
import type { XeroInvoice } from '@bc5000/integrations/xero';
import type { JobPayloads } from '@bc5000/jobs';

import { commitXeroSync, startXeroSync, type XeroSyncJobDependencies } from './xero-invoice-refresh.js';

async function mapWithConcurrency<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) { const current = items[index]; index += 1; if (current !== undefined) await action(current); }
  });
  await Promise.all(workers);
}

const terminal = (invoice: XeroInvoice) => invoice.status === 'PAID' || invoice.status === 'VOIDED' || invoice.status === 'DELETED' || Number(invoice.amountDue) <= 0;

export async function reconcileNightly(dependencies: XeroSyncJobDependencies, payload: JobPayloads['xero.nightly-reconcile']) {
  const { sync, connection } = await startXeroSync(dependencies, payload.organisationId);
  const listed = await sync.xero.listOutstandingInvoices();
  const remoteIds = new Set(listed.data.map((invoice) => invoice.id));
  const localEligible = await dependencies.database.select({ xeroInvoiceId: invoices.xeroInvoiceId }).from(invoices).where(and(eq(invoices.organisationId, payload.organisationId), eq(invoices.type, 'ACCREC'), eq(invoices.status, 'AUTHORISED'), gt(invoices.amountDue, '0')));
  const missing = localEligible.filter((invoice) => !remoteIds.has(invoice.xeroInvoiceId));
  const confirmedInvoices: XeroInvoice[] = [];
  await mapWithConcurrency(missing, 4, async (local) => {
    const confirmed = await sync.xero.getInvoice(local.xeroInvoiceId);
    confirmedInvoices.push(confirmed.data);
  });
  const upserted = listed.data.length + confirmedInvoices.length;
  const confirmedTerminal = confirmedInvoices.filter(terminal).length;
  const summary = { remoteEligible: listed.data.length, localEligible: localEligible.length, missingLocally: listed.data.filter((invoice) => !localEligible.some((local) => local.xeroInvoiceId === invoice.id)).length, targetedConfirmations: missing.length, confirmedTerminal, upserted, apiHeadroom: listed.rateLimit.remaining };
  await commitXeroSync(
    sync,
    payload.organisationId,
    connection,
    [...listed.data, ...confirmedInvoices],
    {
      completionAudit: {
        eventType: 'XERO_RECONCILIATION_COMPLETED',
        afterValue: summary
      }
    }
  );
  return summary;
}
