import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';

import { createBusinessCalendar } from './calendar.js';

export interface VoiceSequenceInvoiceCandidate {
  invoiceId: string;
  customerId: string;
  amountDue: string;
  currency: string;
}

export interface VoiceSequenceGroupingInput {
  organisationId: string;
  sequenceVersionId: string;
  stageKey: string;
  localOccurrenceDate: string;
  invoices: readonly VoiceSequenceInvoiceCandidate[];
}

export interface VoiceSequenceCandidate {
  organisationId: string;
  sequenceVersionId: string;
  stageKey: string;
  customerId: string;
  localOccurrenceDate: string;
  currency: string;
  combinedAmount: string;
  invoices: VoiceSequenceInvoiceCandidate[];
}

const compareInvoices = (
  left: VoiceSequenceInvoiceCandidate,
  right: VoiceSequenceInvoiceCandidate
): number =>
  left.customerId.localeCompare(right.customerId) ||
  left.currency.localeCompare(right.currency) ||
  left.invoiceId.localeCompare(right.invoiceId) ||
  left.amountDue.localeCompare(right.amountDue);

export function groupVoiceSequenceCandidates(
  input: VoiceSequenceGroupingInput
): VoiceSequenceCandidate[] {
  const groups = new Map<
    string,
    Omit<VoiceSequenceCandidate, 'combinedAmount'> & {
      invoiceIds: Set<string>;
    }
  >();

  for (const invoice of [...input.invoices].sort(compareInvoices)) {
    const key = `${invoice.customerId}\u0000${invoice.currency}`;
    const existing = groups.get(key) ?? {
      organisationId: input.organisationId,
      sequenceVersionId: input.sequenceVersionId,
      stageKey: input.stageKey,
      customerId: invoice.customerId,
      localOccurrenceDate: input.localOccurrenceDate,
      currency: invoice.currency,
      invoices: [],
      invoiceIds: new Set<string>()
    };
    if (!existing.invoiceIds.has(invoice.invoiceId)) {
      existing.invoiceIds.add(invoice.invoiceId);
      existing.invoices.push(invoice);
    }
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((candidate) => ({
      organisationId: candidate.organisationId,
      sequenceVersionId: candidate.sequenceVersionId,
      stageKey: candidate.stageKey,
      customerId: candidate.customerId,
      localOccurrenceDate: candidate.localOccurrenceDate,
      currency: candidate.currency,
      invoices: candidate.invoices,
      combinedAmount: candidate.invoices
        .reduce(
          (total, invoice) => total.plus(invoice.amountDue),
          new Decimal(0)
        )
        .toFixed(2)
    }))
    .sort(
      (left, right) =>
        left.customerId.localeCompare(right.customerId) ||
        left.currency.localeCompare(right.currency)
    );
}

export function voiceSequenceIdempotencyKey(
  candidate: VoiceSequenceCandidate
): string {
  return [
    'voice-sequence',
    candidate.organisationId,
    candidate.sequenceVersionId,
    candidate.stageKey,
    candidate.customerId,
    candidate.localOccurrenceDate,
    candidate.currency
  ].join(':');
}

export interface VoiceDispatchWindowInput {
  requestedAt: Date;
  lastCompletedAt: Date | null;
  cooldownSeconds: number;
  timezone: string;
  holidays: readonly string[];
  weekdayStartLocal: string;
  weekdayEndLocal: string;
}

const parseWindowTime = (value: string): { hour: number; minute: number } => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) throw new Error(`Invalid local time: ${value}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
};

const localWindowTime = (
  date: DateTime,
  value: string,
  timezone: string
): DateTime => {
  const { hour, minute } = parseWindowTime(value);
  const localDate = date.toISODate();
  if (localDate === null) throw new Error('Invalid dispatch instant');
  const result = DateTime.fromObject(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute,
      second: 0,
      millisecond: 0
    },
    { zone: timezone }
  );
  if (!result.isValid) throw new Error(`Invalid dispatch window: ${value}`);
  return result;
};

export function nextVoiceDispatchAt(input: VoiceDispatchWindowInput): Date {
  if (!Number.isFinite(input.cooldownSeconds) || input.cooldownSeconds < 0) {
    throw new Error('cooldownSeconds must be a non-negative number');
  }
  const requestedMillis = input.requestedAt.getTime();
  const cooldownMillis =
    input.lastCompletedAt === null
      ? Number.NEGATIVE_INFINITY
      : input.lastCompletedAt.getTime() + input.cooldownSeconds * 1_000;
  const candidate = DateTime.fromMillis(
    Math.max(requestedMillis, cooldownMillis),
    { zone: input.timezone }
  );
  if (!candidate.isValid) throw new Error('Invalid dispatch instant');

  const calendar = createBusinessCalendar({
    zone: input.timezone,
    holidays: [...input.holidays]
  });
  const localDate = candidate.toISODate();
  if (localDate === null) throw new Error('Invalid dispatch instant');

  if (calendar.isBusinessDate(localDate)) {
    const start = localWindowTime(
      candidate,
      input.weekdayStartLocal,
      input.timezone
    );
    const end = localWindowTime(
      candidate,
      input.weekdayEndLocal,
      input.timezone
    );
    if (start >= end) throw new Error('Dispatch window start must precede end');
    if (candidate < start) return start.toJSDate();
    if (candidate < end) return candidate.toJSDate();
  }

  const nextDate = DateTime.fromISO(calendar.nextBusinessDate(localDate), {
    zone: input.timezone
  });
  return localWindowTime(
    nextDate,
    input.weekdayStartLocal,
    input.timezone
  ).toJSDate();
}
