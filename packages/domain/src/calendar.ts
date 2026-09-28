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
