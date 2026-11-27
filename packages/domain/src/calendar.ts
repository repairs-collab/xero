import { DateTime } from 'luxon';

export interface BusinessCalendar {
  zone: string;
  isBusinessDate(localDate: string): boolean;
  nextBusinessDate(localDate: string): string;
}

export interface BusinessCalendarOptions {
  zone: string;
  holidays: string[];
}

export interface LocalDateInterval {
  from: Date;
  before: Date;
}

export interface DebtContactWindowDecision {
  allowed: boolean;
  localDate: string;
  reason: 'CONTACT_WINDOW_CLOSED' | null;
}

export const debtContactTimeZone = 'Australia/Sydney';
export const debtContactWindowStartLocal = '08:30';
export const debtContactWindowEndLocal = '17:00';

export interface DebtContactScheduleWindow {
  start: string;
  end: string;
}

export function debtContactScheduleWindow(
  timeZone: string,
  now: Date
): DebtContactScheduleWindow | null {
  const { year } = DateTime.fromJSDate(now, { zone: debtContactTimeZone });
  // January and July cover both seasonal offsets of Australian workspace zones.
  const windows = [1, 7].map((month) => {
    const day = DateTime.fromObject(
      { year, month, day: 15 },
      { zone: debtContactTimeZone }
    ).toISODate();
    const start = DateTime.fromISO(`${day}T${debtContactWindowStartLocal}`, {
      zone: debtContactTimeZone
    }).setZone(timeZone);
    const end = DateTime.fromISO(`${day}T${debtContactWindowEndLocal}`, {
      zone: debtContactTimeZone
    }).setZone(timeZone);
    if (!start.isValid || !end.isValid || start.toISODate() !== end.toISODate()) {
      return null;
    }
    return {
      start: start.toFormat('HH:mm', { locale: 'en-AU' }),
      end: end.toFormat('HH:mm', { locale: 'en-AU' })
    };
  });
  const [summer, winter] = windows;
  if (!summer || !winter) return null;
  const start = summer.start > winter.start ? summer.start : winter.start;
  const end = summer.end < winter.end ? summer.end : winter.end;
  return start < end ? { start, end } : null;
}

const parseLocalDate = (localDate: string, zone: string): DateTime => {
  const parsed = DateTime.fromISO(localDate, { zone });
  if (!parsed.isValid || parsed.toISODate() !== localDate) {
    throw new Error(`Invalid local date: ${localDate}`);
  }
  return parsed;
};

export function localDateInterval(
  localDate: string,
  zone: string
): LocalDateInterval {
  const from = parseLocalDate(localDate, zone).startOf('day');
  return {
    from: from.toJSDate(),
    before: from.plus({ days: 1 }).toJSDate()
  };
}

export function createBusinessCalendar(
  options: BusinessCalendarOptions
): BusinessCalendar {
  const holidays = new Set(options.holidays);

  const isBusinessDate = (localDate: string): boolean => {
    const date = parseLocalDate(localDate, options.zone);
    return date.weekday <= 5 && !holidays.has(localDate);
  };

  return {
    zone: options.zone,
    isBusinessDate,
    nextBusinessDate(localDate) {
      let candidate = parseLocalDate(localDate, options.zone).plus({ days: 1 });
      while (!isBusinessDate(candidate.toISODate() ?? '')) {
        candidate = candidate.plus({ days: 1 });
      }
      return candidate.toISODate() ?? '';
    }
  };
}

export function decideDebtContactWindow(
  now: Date,
  holidays: readonly string[]
): DebtContactWindowDecision {
  const local = DateTime.fromJSDate(now, { zone: debtContactTimeZone });
  const localDate = local.toISODate() ?? '';
  const calendar = createBusinessCalendar({
    zone: debtContactTimeZone,
    holidays: [...holidays]
  });
  const localMinute = local.hour * 60 + local.minute;
  const allowed =
    calendar.isBusinessDate(localDate) &&
    localMinute >= 8 * 60 + 30 && localMinute < 17 * 60;
  return {
    allowed,
    localDate,
    reason: allowed ? null : 'CONTACT_WINDOW_CLOSED'
  };
}

export function nextDebtContactOpening(
  after: Date,
  holidays: readonly string[]
): Date {
  const local = DateTime.fromJSDate(after, { zone: debtContactTimeZone });
  const localDate = local.toISODate() ?? '';
  const calendar = createBusinessCalendar({
    zone: debtContactTimeZone,
    holidays: [...holidays]
  });
  const localMinute = local.hour * 60 + local.minute;
  const openingDate =
    calendar.isBusinessDate(localDate) && localMinute < 8 * 60 + 30
      ? localDate
      : calendar.nextBusinessDate(localDate);
  const opening = DateTime.fromISO(
    `${openingDate}T${debtContactWindowStartLocal}`,
    { zone: debtContactTimeZone }
  );
  if (!opening.isValid) throw new Error('Next debt-contact opening is invalid');
  return opening.toJSDate();
}
