import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerClock } from '../src/server/clock.js';

describe('createServerClock', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('uses a fixed instant only for the explicitly enabled browser-test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ACCOUNTPULSE_E2E', 'browser-journeys-only');
    vi.stubEnv('ACCOUNTPULSE_E2E_NOW', '2026-10-08T02:00:00.000Z');

    expect(createServerClock().now().toISOString()).toBe(
      '2026-10-08T02:00:00.000Z'
    );
  });

  it('ignores the browser-test instant unless the test runtime is explicitly enabled', () => {
    vi.stubEnv('ACCOUNTPULSE_E2E', 'false');
    vi.stubEnv('ACCOUNTPULSE_E2E_NOW', '2026-10-08T02:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T01:00:00.000Z'));

    expect(createServerClock().now().toISOString()).toBe(
      '2026-10-11T01:00:00.000Z'
    );
  });
});
