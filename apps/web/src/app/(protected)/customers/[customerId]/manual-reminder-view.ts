import { evaluateProviderSendPolicy } from '@bc5000/domain';

export interface ManualReminderViewInput {
  customerName: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  dueDate: string;
  type: string;
  status: string;
  onlineInvoiceUrl: string | null;
  email: string | null;
  phone: string | null;
  chasingPaused: boolean;
  customerActive: boolean;
  hasActiveChase: boolean;
  smsSuppressed: boolean;
  emailSuppressed: boolean;
  sendMode: 'dry-run' | 'live';
  liveSendAcknowledged: boolean;
  rolloutScope: 'CONTROLLED' | 'CUSTOMER';
  maintenanceMode: boolean;
  recipientAllowlist: string[];
  blockingReason?: string | null;
}

const sendingUnavailableReason = (
  input: ManualReminderViewInput
): string | null => {
  if (input.blockingReason) return input.blockingReason;
  if (input.chasingPaused) return 'Resume chasing before sending a reminder';
  if (!input.customerActive) return 'Customer is inactive in Xero';
  if (!input.hasActiveChase) return 'No active reminder sequence for this invoice';
  if (
    input.type !== 'ACCREC' ||
    input.status !== 'AUTHORISED' ||
    Number(input.amountDue) <= 0
  ) {
    return 'This invoice is not outstanding';
  }
  return null;
};

const policyUnavailableReason = (
  input: ManualReminderViewInput,
  channel: 'SMS' | 'XERO_EMAIL',
  destination: string
): string | null => {
  const decision = evaluateProviderSendPolicy({
    sendMode: input.sendMode,
    liveSendAcknowledged: input.liveSendAcknowledged,
    rolloutScope: input.rolloutScope,
    maintenanceMode: input.maintenanceMode,
    source: channel === 'SMS' ? 'MANUAL_REMINDER' : 'XERO_EMAIL',
    channel,
    destination,
    recipientAllowlist: input.recipientAllowlist
  });
  if (decision.kind === 'provider-call') return null;
  if (decision.kind === 'blocked') {
    return decision.reason === 'OPERATIONAL_MAINTENANCE'
      ? 'Sending is paused for maintenance'
      : 'Sending configuration needs attention';
  }
  if (decision.reason === 'GLOBAL_DRY_RUN') return null;
  if (decision.reason === 'LIVE_NOT_ACKNOWLEDGED') {
    return 'Live sending has not been acknowledged';
  }
  return channel === 'SMS'
    ? 'Mobile is not on the live-send allowlist'
    : 'Email is not on the live-send allowlist';
};

export function createManualReminderView(input: ManualReminderViewInput) {
  const unavailable = sendingUnavailableReason(input);
  const smsUnavailable =
    unavailable ??
    (input.phone === null
      ? 'No usable mobile number'
      : input.onlineInvoiceUrl === null
        ? 'Sync Xero to retrieve the payment link'
        : input.smsSuppressed
          ? 'Customer has opted out of SMS reminders'
          : policyUnavailableReason(input, 'SMS', input.phone));
  const emailUnavailable =
    unavailable ??
    (input.email === null
      ? 'No customer email address'
      : input.emailSuppressed
        ? 'Customer email is suppressed'
        : policyUnavailableReason(input, 'XERO_EMAIL', input.email));
  const amount = Number(input.amountDue).toFixed(2);

  return {
    sms: {
      available: smsUnavailable === null,
      disabledReason: smsUnavailable,
      message:
        input.onlineInvoiceUrl === null
          ? ''
          : `Hi ${input.customerName}, invoice ${input.invoiceNumber} for ${input.currency} ${amount} was due ${input.dueDate}. Pay securely: ${input.onlineInvoiceUrl}`
    },
    email: {
      available: emailUnavailable === null,
      disabledReason: emailUnavailable
    },
    call:
      input.phone === null
        ? { available: false as const, href: null }
        : { available: true as const, href: `tel:${input.phone}` }
  };
}
