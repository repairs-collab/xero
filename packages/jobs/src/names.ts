export const jobNames = {
  xeroInitialSync: 'xero.initial-sync',
  xeroIncrementalSync: 'xero.incremental-sync',
  xeroInvoiceRefresh: 'xero.invoice-refresh',
  xeroNightlyReconcile: 'xero.nightly-reconcile',
  remindersCalculate: 'reminders.calculate',
  voiceRemindersCalculate: 'voice-reminders.calculate',
  reminderExecute: 'reminder.execute',
  operatorReplyExecute: 'operator-reply.execute',
  testSmsExecute: 'test-sms.execute',
  voiceCallExecute: 'voice-call.execute',
  voiceCallReconcile: 'voice-call.reconcile',
  providerConnectionTest: 'provider.connection-test',
  webhookProcess: 'webhook.process',
  retentionApply: 'retention.apply'
} as const;

export type JobName = (typeof jobNames)[keyof typeof jobNames];

export const allJobNames = Object.values(jobNames);
