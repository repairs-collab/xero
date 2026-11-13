import type { XeroInitialSyncJob } from '@bc5000/jobs';

import {
  commitXeroSync,
  startXeroSync,
  type XeroSyncJobDependencies
} from './xero-invoice-refresh.js';

export async function runInitialSync(
  dependencies: XeroSyncJobDependencies,
  payload: XeroInitialSyncJob
): Promise<void> {
  const { sync, connection } = await startXeroSync(dependencies, payload.organisationId);
  const response = await sync.xero.listOutstandingInvoices();
  await commitXeroSync(
    sync,
    payload.organisationId,
    connection,
    response.data
  );
}
