import { describe, expect, it, vi } from 'vitest';

import { createPlatformEmailMonitoringService } from './platform-email-monitoring-service.js';

describe('platform email monitoring service', () => {
  it('authorizes before reading and uses one clock reading for the 24-hour window', async () => {
    const now = new Date('2026-11-22T02:00:00.000Z');
    const readSnapshot = vi.fn().mockResolvedValue({
      metrics: { pendingOrRetry: 0, unknown: 0, failedLast24Hours: 0, sentLast24Hours: 0 },
      rows: []
    });
    const clock = { now: vi.fn(() => now) };
    const service = createPlatformEmailMonitoringService({
      verifyOwner: (userId) => Promise.resolve(userId === 'owner-user'),
      repository: { readSnapshot },
      clock
    });

    await expect(service.getSnapshot('owner-user')).resolves.toMatchObject({ rows: [] });
    expect(clock.now).toHaveBeenCalledOnce();
    expect(readSnapshot).toHaveBeenCalledWith({
      now,
      since: new Date('2026-11-21T02:00:00.000Z'),
      limit: 50
    });
  });

  it('denies a non-owner before repository access', async () => {
    const readSnapshot = vi.fn();
    const service = createPlatformEmailMonitoringService({
      verifyOwner: () => Promise.resolve(false),
      repository: { readSnapshot },
      clock: { now: () => new Date('2026-11-22T02:00:00.000Z') }
    });

    await expect(service.getSnapshot('customer-admin')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});
