import type { XeroInitialSyncJob } from '@bc5000/jobs';

import {
  assertXeroSyncAllowed,
  recordSuccessfulSync,
  synchroniseInvoiceCollection,
  type XeroSyncDependencies
} from './xero-invoice-refresh.js';

export async function runInitialSync(
  dependencies: XeroSyncDependencies,
  payload: XeroInitialSyncJob
): Promise<void> {
  await assertXeroSyncAllowed(dependencies, payload.organisationId);
  const response = await dependencies.xero.listOutstandingInvoices();
  await synchroniseInvoiceCollection(
    dependencies,
    payload.organisationId,
    response.data
  );
  await recordSuccessfulSync(dependencies, payload.organisationId);
}
