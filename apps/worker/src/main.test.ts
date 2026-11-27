import { jobNames } from '@bc5000/jobs';
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
    const startHeartbeat = vi.fn();

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
        bootstrap,
        startHeartbeat
      })
    ).rejects.toThrow('bootstrap failed');

    expect(start).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    expect(startHeartbeat).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('starts its heartbeat after handlers register and stops it before shutdown', async () => {
    const operations: string[] = [];
    const worker = await startWorker({
      queue: {
        start: vi.fn().mockResolvedValue(undefined),
        schedule: vi.fn().mockResolvedValue(undefined),
        register: () => {
          operations.push('registered');
          return Promise.resolve();
        },
        stop: vi.fn().mockResolvedValue(undefined),
        stopClaiming: () => {
          operations.push('claims stopped');
          return Promise.resolve();
        }
      } as never,
      database: { close: vi.fn().mockResolvedValue(undefined) },
      organisationIds: [],
      handlers: { [jobNames.testSmsExecute]: () => Promise.resolve() },
      startHeartbeat: () => {
        operations.push('heartbeat started');
        return () => { operations.push('heartbeat stopped'); };
      }
    });

    await worker.shutdown();
    await worker.shutdown();
    expect(operations).toEqual([
      'registered',
      'heartbeat started',
      'heartbeat stopped',
      'claims stopped'
    ]);
  });
});
