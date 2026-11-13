export const jobNames = {
  xeroInitialSync: 'xero.initial-sync',
  xeroIncrementalSync: 'xero.incremental-sync',
  xeroInvoiceRefresh: 'xero.invoice-refresh',
  xeroOAuthCleanup: 'xero.oauth-cleanup',
  xeroNightlyReconcile: 'xero.nightly-reconcile',
  remindersCalculate: 'reminders.calculate',
  voiceRemindersCalculate: 'voice-reminders.calculate',
  voiceRemindersDispatch: 'voice-reminders.dispatch',
  reminderExecute: 'reminder.execute',
  operatorReplyExecute: 'operator-reply.execute',
  testSmsExecute: 'test-sms.execute',
  smsNumberProvision: 'sms-number.provision',
  smsNumberProvisionReconcile: 'sms-number.provision-reconcile',
  smsOverageInvoiceReconcile: 'sms-overage.invoice-reconcile',
  voiceCallExecute: 'voice-call.execute',
  voiceCallReconcile: 'voice-call.reconcile',
  providerConnectionTest: 'provider.connection-test',
  webhookProcess: 'webhook.process',
  retentionApply: 'retention.apply',
  subscriptionLifecycle: 'subscription.lifecycle',
  subscriptionLifecycleReconcile: 'subscription.lifecycle-reconcile',
  subscriptionTrialExpiry: 'subscription.trial-expiry'
} as const;

export type JobName = (typeof jobNames)[keyof typeof jobNames];

export const allJobNames = Object.values(jobNames);
