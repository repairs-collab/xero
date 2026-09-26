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
}

const sendingUnavailableReason = (
  input: ManualReminderViewInput
): string | null => {
  if (input.chasingPaused) return 'Resume chasing before sending a reminder';
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
        : null);
  const emailUnavailable =
    unavailable ?? (input.email === null ? 'No customer email address' : null);
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
