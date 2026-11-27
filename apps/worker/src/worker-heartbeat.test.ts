import { describe, expect, it } from 'vitest';

import { isWorkerHeartbeatCurrent } from './worker-heartbeat.js';

describe('worker heartbeat', () => {
  const now = Date.parse('2026-11-27T02:00:00.000Z');
  const heartbeat = {
    pid: 2,
    processStartTicks: '12345',
    updatedAt: new Date(now - 15_000).toISOString()
  };
  const matchingWorker = () => heartbeat.processStartTicks;

  it('accepts a recent heartbeat from the current worker process', () => {
    expect(isWorkerHeartbeatCurrent(heartbeat, matchingWorker, now)).toBe(true);
  });

  it('rejects stale, future or malformed timestamps', () => {
    for (const updatedAt of [
      '2026-11-27T01:58:59.999Z',
      '2026-11-27T02:00:00.001Z',
      'invalid'
    ]) {
      expect(isWorkerHeartbeatCurrent({ ...heartbeat, updatedAt }, matchingWorker, now)).toBe(false);
    }
  });

  it('rejects a stale marker from a dead process or recycled PID', () => {
    expect(isWorkerHeartbeatCurrent(heartbeat, () => undefined, now)).toBe(false);
    expect(isWorkerHeartbeatCurrent(heartbeat, () => '55555', now)).toBe(false);
    expect(isWorkerHeartbeatCurrent(null, matchingWorker, now)).toBe(false);
  });
});
