export interface ServerClock {
  now(): Date;
}

export function createServerClock(): ServerClock {
  const fixedNow =
    process.env.NODE_ENV !== 'production' &&
    process.env.ACCOUNTPULSE_E2E === 'browser-journeys-only'
      ? process.env.ACCOUNTPULSE_E2E_NOW?.trim()
      : undefined;

  if (fixedNow === undefined || fixedNow === '') {
    return { now: () => new Date() };
  }

  const timestamp = Date.parse(fixedNow);
  if (Number.isNaN(timestamp)) {
    throw new Error('ACCOUNTPULSE_E2E_NOW must be an ISO date-time');
  }

  return { now: () => new Date(timestamp) };
}
