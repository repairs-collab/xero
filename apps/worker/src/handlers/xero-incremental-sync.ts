import { organisations } from '@bc5000/db';
import type { XeroIncrementalSyncJob } from '@bc5000/jobs';
import { eq } from 'drizzle-orm';

import {
  recordSuccessfulSync,
  synchroniseInvoiceSnapshot,
  type XeroSyncDependencies
} from './xero-invoice-refresh.js';

export async function runIncrementalSync(
  dependencies: XeroSyncDependencies,
  payload: XeroIncrementalSyncJob
): Promise<void> {
  const rows = await dependencies.database
    .select({ cursor: organisations.xeroSyncCursor })
    .from(organisations)
    .where(eq(organisations.id, payload.organisationId))
    .limit(1);
  const cursor = rows[0]?.cursor;
  if (cursor === undefined) {
    throw new Error('Organisation was not found');
  }

  const options =
    cursor === null
      ? {}
      : {
          ifModifiedSince: new Date(
            new Date(cursor).getTime() - 2 * 60 * 1000
          ).toISOString()
        };
  const response =
    await dependencies.xero.listOutstandingInvoices(options);
  for (const invoice of response.data) {
    await synchroniseInvoiceSnapshot(
      dependencies,
      payload.organisationId,
      invoice
    );
  }
  await recordSuccessfulSync(dependencies, payload.organisationId);
}
