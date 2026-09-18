import { DateTime } from 'luxon';

import type { BusinessCalendar } from './calendar.js';

export type DailyBasis = 'BUSINESS_DAYS' | 'CALENDAR_DAYS';
export type ReminderStageChannel =
  | 'SMS'
  | 'XERO_EMAIL'
  | 'TASK'
  | 'SMS_DAILY';

export interface ReminderStage {
  id: string;
  offsetDays: number;
  channels: ReminderStageChannel[];
}

export interface ReminderSequence {
  organisationId: string;
  sequenceVersionId: string;
  zone: string;
  sendTime: string;
  socialWindow: {
    start: string;
    end: string;
  };
  dailyBasis: DailyBasis;
  asOfLocalDate?: string;
  stages: ReminderStage[];
}

export interface InvoiceSnapshot {
  invoiceId: string;
  customerId: string;
  dueDate: string;
  amountDue: string;
  currency: string;
}

export interface StageOccurrence {
  organisationId: string;
  sequenceVersionId: string;
  stageId: string;
  invoiceId: string;
  customerId: string;
  channel: 'SMS' | 'XERO_EMAIL' | 'TASK';
  scheduledAtUtc: string;
  localDate: string;
}

export interface StarterSequenceOptions {
  organisationId?: string;
  sequenceVersionId?: string;
}

export function starterSequence(
  options: StarterSequenceOptions = {}
): ReminderSequence {
  return {
    organisationId: options.organisationId ?? 'default-organisation',
    sequenceVersionId:
      options.sequenceVersionId ?? 'starter-sequence-version',
    zone: 'Australia/Sydney',
    sendTime: '09:00',
    socialWindow: {
      start: '08:00',
      end: '18:00'
    },
    dailyBasis: 'BUSINESS_DAYS',
    stages: [
      { id: 'due-date', offsetDays: 0, channels: ['SMS'] },
      {
        id: 'seven-days',
        offsetDays: 7,
        channels: ['XERO_EMAIL', 'SMS']
      },
      { id: 'twenty-one-days', offsetDays: 21, channels: ['SMS'] },
      {
        id: 'thirty-days',
        offsetDays: 30,
        channels: ['TASK', 'SMS_DAILY']
      }
    ]
  };
}

const localDateAtOffset = (
  dueDate: string,
  offsetDays: number,
  zone: string
): string => {
  const date = DateTime.fromISO(dueDate, { zone }).plus({ days: offsetDays });
  const result = date.toISODate();
  if (!date.isValid || result === null) {
    throw new Error(`Invalid due date: ${dueDate}`);
  }
  return result;
};

const scheduledAtUtc = (
  localDate: string,
  localTime: string,
  zone: string
): string => {
  const local = DateTime.fromISO(`${localDate}T${localTime}`, { zone });
  const utc = local.toUTC().toISO({ suppressMilliseconds: false });
  if (!local.isValid || utc === null) {
    throw new Error(`Invalid schedule time: ${localDate} ${localTime}`);
  }
  return utc;
};

const createOccurrence = (
  sequence: ReminderSequence,
  invoice: InvoiceSnapshot,
  stageId: string,
  channel: StageOccurrence['channel'],
  localDate: string
): StageOccurrence => ({
  organisationId: sequence.organisationId,
  sequenceVersionId: sequence.sequenceVersionId,
  stageId,
  invoiceId: invoice.invoiceId,
  customerId: invoice.customerId,
  channel,
  scheduledAtUtc: scheduledAtUtc(localDate, sequence.sendTime, sequence.zone),
  localDate
});

export function calculateStageOccurrences(
  sequence: ReminderSequence,
  invoices: InvoiceSnapshot[],
  calendar: BusinessCalendar
): StageOccurrence[] {
  if (sequence.asOfLocalDate === undefined) {
    throw new Error('asOfLocalDate is required');
  }

  const occurrences: StageOccurrence[] = [];

  for (const invoice of invoices) {
    for (const stage of sequence.stages) {
      const stageDate = localDateAtOffset(
        invoice.dueDate,
        stage.offsetDays,
        sequence.zone
      );

      if (stageDate > sequence.asOfLocalDate) continue;

      for (const channel of stage.channels) {
        if (channel === 'SMS_DAILY') {
          let dailyDate = stageDate;
          while (dailyDate <= sequence.asOfLocalDate) {
            if (
              sequence.dailyBasis === 'CALENDAR_DAYS' ||
              calendar.isBusinessDate(dailyDate)
            ) {
              occurrences.push(
                createOccurrence(
                  sequence,
                  invoice,
                  'daily-after-30',
                  'SMS',
                  dailyDate
                )
              );
            }
            dailyDate = localDateAtOffset(dailyDate, 1, sequence.zone);
          }
        } else {
          occurrences.push(
            createOccurrence(sequence, invoice, stage.id, channel, stageDate)
          );
        }
      }
    }
  }

  return occurrences.sort(
    (left, right) =>
      left.scheduledAtUtc.localeCompare(right.scheduledAtUtc) ||
      left.invoiceId.localeCompare(right.invoiceId) ||
      left.channel.localeCompare(right.channel)
  );
}
