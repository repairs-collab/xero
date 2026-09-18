import { Decimal } from 'decimal.js';

import type { StageOccurrence } from './reminders.js';

export type SmsAggregationStrategy =
  | 'CONSOLIDATED_CUSTOMER'
  | 'PER_INVOICE';

export interface MessageOccurrence extends StageOccurrence {
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  onlineInvoiceUrl: string;
}

export interface SmsGroup {
  organisationId: string;
  sequenceVersionId: string;
  stageId: string;
  customerId: string;
  localDate: string;
  invoiceIds: string[];
  invoiceNumbers: string[];
  onlineInvoiceUrls: string[];
  currency: string;
  totalDue: string;
}

const groupKey = (
  strategy: SmsAggregationStrategy,
  occurrence: MessageOccurrence
): string =>
  [
    occurrence.organisationId,
    occurrence.sequenceVersionId,
    occurrence.stageId,
    occurrence.customerId,
    occurrence.localDate,
    strategy === 'PER_INVOICE' ? occurrence.invoiceId : ''
  ].join('|');

export function groupSmsOccurrences(
  strategy: SmsAggregationStrategy,
  occurrences: MessageOccurrence[]
): SmsGroup[] {
  const groups = new Map<string, SmsGroup>();
  const smsOccurrences = occurrences
    .filter((occurrence) => occurrence.channel === 'SMS')
    .sort(
      (left, right) =>
        groupKey(strategy, left).localeCompare(groupKey(strategy, right)) ||
        left.invoiceId.localeCompare(right.invoiceId)
    );

  for (const occurrence of smsOccurrences) {
    const key = groupKey(strategy, occurrence);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, {
        organisationId: occurrence.organisationId,
        sequenceVersionId: occurrence.sequenceVersionId,
        stageId: occurrence.stageId,
        customerId: occurrence.customerId,
        localDate: occurrence.localDate,
        invoiceIds: [occurrence.invoiceId],
        invoiceNumbers: [occurrence.invoiceNumber],
        onlineInvoiceUrls: [occurrence.onlineInvoiceUrl],
        currency: occurrence.currency,
        totalDue: new Decimal(occurrence.amountDue).toString()
      });
      continue;
    }

    if (existing.currency !== occurrence.currency) {
      throw new Error('Cannot consolidate mixed currencies');
    }

    existing.invoiceIds.push(occurrence.invoiceId);
    existing.invoiceNumbers.push(occurrence.invoiceNumber);
    existing.onlineInvoiceUrls.push(occurrence.onlineInvoiceUrl);
    existing.totalDue = new Decimal(existing.totalDue)
      .plus(occurrence.amountDue)
      .toString();
  }

  return [...groups.values()];
}
