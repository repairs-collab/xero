import type { XeroInitialSyncJob } from '@bc5000/jobs';

import {
  recordSuccessfulSync,
  synchroniseInvoiceSnapshot,
  type XeroSyncDependencies
} from './xero-invoice-refresh.js';

export async function runInitialSync(
  dependencies: XeroSyncDependencies,
  payload: XeroInitialSyncJob
): Promise<void> {
  const response = await dependencies.xero.listOutstandingInvoices();
  for (const invoice of response.data) {
    await synchroniseInvoiceSnapshot(
      dependencies,
      payload.organisationId,
      invoice
    );
  }
  await recordSuccessfulSync(dependencies, payload.organisationId);
}
