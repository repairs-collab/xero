import type {
  JobPublisher,
  XeroIncrementalSyncJob,
  XeroInitialSyncJob,
  XeroInvoiceRefreshJob
} from './contracts.js';

export const createXeroJobProducers = (publisher: JobPublisher) => ({
  initialSync: (payload: XeroInitialSyncJob) =>
    publisher.publish('xero.initial-sync', payload, {
      singletonKey: `xero.initial-sync:${payload.organisationId}`
    }),
  incrementalSync: (payload: XeroIncrementalSyncJob) =>
    publisher.publish('xero.incremental-sync', payload, {
      singletonKey: `xero.incremental-sync:${payload.organisationId}`
    }),
  invoiceRefresh: (payload: XeroInvoiceRefreshJob) =>
    publisher.publish('xero.invoice-refresh', payload, {
      singletonKey: `xero.invoice-refresh:${payload.organisationId}:${payload.invoiceId}`
    })
});
