import type { JobName } from './names.js';
import type { JobPayloads } from './payloads.js';

export type {
  JobPayloads,
  XeroIncrementalSyncJob,
  XeroInitialSyncJob,
  XeroInvoiceRefreshJob
} from './payloads.js';
export type { JobName } from './names.js';

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
