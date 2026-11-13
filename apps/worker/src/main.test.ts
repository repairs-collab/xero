import { describe, expect, it, vi } from 'vitest';

import { startWorker } from './main.js';

describe('worker bootstrap cleanup', () => {
  it('closes the queue and database when bootstrap reconciliation fails', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const schedule = vi
      .fn()
      .mockRejectedValue(new Error('schedule should not run'));
    const bootstrap = vi.fn().mockRejectedValue(new Error('bootstrap failed'));
    const close = vi.fn().mockResolvedValue(undefined);

    await expect(
      startWorker({
        queue: {
          start,
          stop,
          schedule,
          register: vi.fn(),
          stopClaiming: vi.fn()
        } as never,
        database: { close },
        organisationIds: [],
        handlers: {},
        bootstrap
      })
    ).rejects.toThrow('bootstrap failed');

    expect(start).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
