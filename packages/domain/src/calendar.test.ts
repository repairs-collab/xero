import { describe, expect, it } from 'vitest';

import { createBusinessCalendar } from './calendar.js';

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
