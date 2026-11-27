import { describe, expect, it } from 'vitest';

import {
  createBusinessCalendar,
  debtContactScheduleWindow,
  decideDebtContactWindow
} from './calendar.js';

describe('createBusinessCalendar', () => {
  it('skips Sydney weekends and configured NSW public holidays', () => {
    const calendar = createBusinessCalendar({
      zone: 'Australia/Sydney',
      holidays: ['2026-10-05']
    });

    expect(calendar.isBusinessDate('2026-10-03')).toBe(false);
    expect(calendar.isBusinessDate('2026-10-05')).toBe(false);
    expect(calendar.nextBusinessDate('2026-10-02')).toBe('2026-10-06');
  });
});

describe('debtContactScheduleWindow', () => {
  it.each([
    ['Australia/Sydney', '08:30', '17:00'],
    ['Australia/Brisbane', '08:30', '16:00'],
    ['Australia/Perth', '06:30', '14:00'],
    ['Australia/Adelaide', '08:00', '16:30']
  ])('converts the recurring Sydney contact window for %s', (timeZone, start, end) => {
    expect(debtContactScheduleWindow(timeZone, new Date('2026-11-27T00:00:00Z'))).toEqual({ start, end });
  });
});

describe('decideDebtContactWindow', () => {
  it.each([
    ['one second before opening', '2026-05-31T22:29:59.000Z', false],
    ['exactly at 08:30', '2026-05-31T22:30:00.000Z', true],
    ['one second before closing', '2026-06-01T06:59:59.000Z', true],
    ['exactly at 17:00', '2026-06-01T07:00:00.000Z', false]
  ])(
    'uses the fixed Sydney weekday window %s',
    (_label, instant, allowed) => {
      expect(
        decideDebtContactWindow(new Date(instant), [])
      ).toEqual({
        allowed,
        localDate: '2026-06-01',
        reason: allowed ? null : 'CONTACT_WINDOW_CLOSED'
      });
    }
  );

  it.each([
    ['Sydney Saturday', '2026-06-05T23:30:00.000Z', []],
    [
      'configured Sydney public holiday',
      '2026-10-04T21:30:00.000Z',
      ['2026-10-05']
    ]
  ])('rejects a %s', (_label, instant, holidays) => {
    expect(decideDebtContactWindow(new Date(instant), holidays)).toMatchObject({
      allowed: false,
      reason: 'CONTACT_WINDOW_CLOSED'
    });
  });
});
