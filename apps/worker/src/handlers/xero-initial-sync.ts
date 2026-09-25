import type { XeroInitialSyncJob } from '@bc5000/jobs';

import {
  recordSuccessfulSync,
  synchroniseInvoiceCollection,
  type XeroSyncDependencies
} from './xero-invoice-refresh.js';

export async function runInitialSync(
  dependencies: XeroSyncDependencies,
  payload: XeroInitialSyncJob
): Promise<void> {
  const response = await dependencies.xero.listOutstandingInvoices();
  await synchroniseInvoiceCollection(
    dependencies,
    payload.organisationId,
    response.data
  );
  await recordSuccessfulSync(dependencies, payload.organisationId);
}
