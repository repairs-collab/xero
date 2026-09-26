import { describe, expect, it } from 'vitest';

import { createBusinessCalendar } from './calendar.js';
import {
  calculateStageOccurrences,
  starterSequence,
  type ReminderSequence
} from './reminders.js';

const calendar = createBusinessCalendar({
  zone: 'Australia/Sydney',
  holidays: []
});

const sequenceFixture = (
  patch: Partial<ReminderSequence> = {}
): ReminderSequence => ({
  ...starterSequence({
    organisationId: 'org-1',
    sequenceVersionId: 'sequence-version-1'
  }),
  asOfLocalDate: '2026-09-18',
  ...patch
});

describe('starterSequence', () => {
  it('creates the four approved starter stages', () => {
    expect(starterSequence().stages.map((stage) => [stage.offsetDays, stage.channels])).toEqual([
      [0, ['SMS']],
      [7, ['XERO_EMAIL', 'SMS']],
      [21, ['SMS']],
      [30, ['TASK', 'SMS_DAILY']]
    ]);
  });
});

describe('calculateStageOccurrences', () => {
  it('creates only the current Sydney business-day SMS after day 30', () => {
    const result = calculateStageOccurrences(
      sequenceFixture({ dailyBasis: 'BUSINESS_DAYS' }),
      [
        {
          invoiceId: 'invoice-1',
          customerId: 'customer-1',
          dueDate: '2026-08-17',
          amountDue: '500.00',
          currency: 'AUD'
        }
      ],
      calendar
    );

    expect(
      result.map((occurrence) => [
        occurrence.stageId,
        occurrence.channel,
        occurrence.localDate
      ])
    ).toEqual([
      ['thirty-days', 'TASK', '2026-09-16'],
      ['daily-after-30', 'SMS', '2026-09-18']
    ]);
  });

  it('creates only the latest applicable fixed reminder stage', () => {
    const result = calculateStageOccurrences(
      sequenceFixture(),
      [
        {
          invoiceId: 'invoice-1',
          customerId: 'customer-1',
          dueDate: '2026-09-08',
          amountDue: '500.00',
          currency: 'AUD'
        }
      ],
      calendar
    );

    expect(
      result.map((occurrence) => [occurrence.stageId, occurrence.channel])
    ).toEqual([
      ['seven-days', 'SMS'],
      ['seven-days', 'XERO_EMAIL']
    ]);
  });

  it('converts the local send time to UTC after applying Sydney DST', () => {
    const result = calculateStageOccurrences(
      sequenceFixture({
        asOfLocalDate: '2026-10-04',
        sendTime: '09:00'
      }),
      [
        {
          invoiceId: 'invoice-1',
          customerId: 'customer-1',
          dueDate: '2026-10-04',
          amountDue: '500.00',
          currency: 'AUD'
        }
      ],
      calendar
    );

    expect(result[0]?.scheduledAtUtc).toBe('2026-10-03T22:00:00.000Z');
  });
});
