import { Decimal } from 'decimal.js';

import type { InvoiceStatus, InvoiceType } from './invoices.js';

export type EligibilityReason =
  | 'NOT_ACCREC'
  | 'NOT_AUTHORISED'
  | 'NO_BALANCE'
  | 'CONTACT_INACTIVE'
  | 'INVOICE_PAUSED'
  | 'CUSTOMER_PAUSED'
  | 'SEQUENCE_PAUSED'
  | 'CHANNEL_UNUSABLE'
  | 'CHANNEL_SUPPRESSED'
  | 'STAGE_COMPLETED';

export interface EligibilityInput {
  type: InvoiceType;
  status: InvoiceStatus;
  amountDue: string;
  contactActive: boolean;
  invoicePaused: boolean;
  customerPaused: boolean;
  sequencePaused: boolean;
  channelUsable: boolean;
  channelSuppressed: boolean;
  stageCompleted: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: EligibilityReason[];
}

export function evaluateEligibility(
  input: EligibilityInput
): EligibilityResult {
  const reasons: EligibilityReason[] = [];

  if (input.type !== 'ACCREC') reasons.push('NOT_ACCREC');
  if (input.status !== 'AUTHORISED') reasons.push('NOT_AUTHORISED');
  if (new Decimal(input.amountDue).lte(0)) reasons.push('NO_BALANCE');
  if (!input.contactActive) reasons.push('CONTACT_INACTIVE');
  if (input.invoicePaused) reasons.push('INVOICE_PAUSED');
  if (input.customerPaused) reasons.push('CUSTOMER_PAUSED');
  if (input.sequencePaused) reasons.push('SEQUENCE_PAUSED');
  if (!input.channelUsable) reasons.push('CHANNEL_UNUSABLE');
  if (input.channelSuppressed) reasons.push('CHANNEL_SUPPRESSED');
  if (input.stageCompleted) reasons.push('STAGE_COMPLETED');

  return { eligible: reasons.length === 0, reasons };
}
