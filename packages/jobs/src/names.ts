export const jobNames = {
  xeroInitialSync: 'xero.initial-sync',
  xeroIncrementalSync: 'xero.incremental-sync',
  xeroInvoiceRefresh: 'xero.invoice-refresh',
  xeroNightlyReconcile: 'xero.nightly-reconcile',
  remindersCalculate: 'reminders.calculate',
  reminderExecute: 'reminder.execute',
  operatorReplyExecute: 'operator-reply.execute',
  providerConnectionTest: 'provider.connection-test',
  webhookProcess: 'webhook.process',
  retentionApply: 'retention.apply'
} as const;

export type JobName = (typeof jobNames)[keyof typeof jobNames];

export const allJobNames = Object.values(jobNames);
