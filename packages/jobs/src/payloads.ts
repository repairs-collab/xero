import { z } from 'zod';

import { jobNames, type JobName } from './names.js';

const identifier = z.string().trim().min(1);
const organisationPayload = z.object({ organisationId: identifier });

export const jobPayloadSchemas = {
  [jobNames.xeroInitialSync]: organisationPayload,
  [jobNames.xeroIncrementalSync]: organisationPayload,
  [jobNames.xeroInvoiceRefresh]: z.object({
    organisationId: identifier,
    invoiceId: identifier,
    webhookEventId: identifier.optional()
  }),
  [jobNames.xeroNightlyReconcile]: organisationPayload,
  [jobNames.remindersCalculate]: organisationPayload,
  [jobNames.reminderExecute]: z.object({
    organisationId: identifier,
    stageInstanceId: identifier
  }),
  [jobNames.webhookProcess]: z.object({
    organisationId: identifier,
    webhookEventId: identifier,
    provider: z.enum(['XERO', 'SINCH'])
  }),
  [jobNames.retentionApply]: organisationPayload
} satisfies Record<JobName, z.ZodType>;

export type JobPayloads = {
  [Name in JobName]: z.infer<(typeof jobPayloadSchemas)[Name]>;
};

export type XeroInitialSyncJob = JobPayloads['xero.initial-sync'];
export type XeroIncrementalSyncJob = JobPayloads['xero.incremental-sync'];
export type XeroInvoiceRefreshJob = JobPayloads['xero.invoice-refresh'];

export function parseJobPayload<Name extends JobName>(
  name: Name,
  payload: unknown
): JobPayloads[Name] {
  return jobPayloadSchemas[name].parse(payload) as JobPayloads[Name];
}
