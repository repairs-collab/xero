export interface XeroInitialSyncJob {
  organisationId: string;
}

export interface XeroIncrementalSyncJob {
  organisationId: string;
}

export interface XeroInvoiceRefreshJob {
  organisationId: string;
  invoiceId: string;
  webhookEventId?: string;
}

export interface JobPayloads {
  'xero.initial-sync': XeroInitialSyncJob;
  'xero.incremental-sync': XeroIncrementalSyncJob;
  'xero.invoice-refresh': XeroInvoiceRefreshJob;
}

export type JobName = keyof JobPayloads;

export interface PublishOptions {
  singletonKey?: string;
  startAfter?: Date;
}

export interface JobPublisher {
  publish<Name extends JobName>(
    name: Name,
    payload: JobPayloads[Name],
    options?: PublishOptions
  ): Promise<string>;
}
