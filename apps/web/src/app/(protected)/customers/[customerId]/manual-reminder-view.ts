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
          : input.sendMode === 'live' &&
              !input.recipientAllowlist.includes(input.phone)
            ? 'Mobile is not on the live-send allowlist'
        : null);
  const emailUnavailable =
    unavailable ??
    (input.email === null
      ? 'No customer email address'
      : input.emailSuppressed
        ? 'Customer email is suppressed'
        : input.sendMode === 'live' &&
            !input.recipientAllowlist.some(
              (recipient) => recipient.toLowerCase() === input.email?.toLowerCase()
            )
          ? 'Email is not on the live-send allowlist'
          : null);
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
