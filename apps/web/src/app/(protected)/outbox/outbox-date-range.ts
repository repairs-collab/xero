import { localDateInterval } from '@bc5000/domain';

const isLocalDate = (value: string | undefined): value is string =>
  value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function parseOutboxDateRange(input: {
  from?: string;
  to?: string;
  timeZone: string;
}): { from?: Date; before?: Date } {
  const range: { from?: Date; before?: Date } = {};
  if (isLocalDate(input.from)) {
    try {
      range.from = localDateInterval(input.from, input.timeZone).from;
    } catch {
      // Invalid local dates are ignored in the same way as malformed input.
    }
  }
  if (isLocalDate(input.to)) {
    try {
      range.before = localDateInterval(input.to, input.timeZone).before;
    } catch {
      // Keep any independently valid lower bound.
    }
  }
  return range;
}
