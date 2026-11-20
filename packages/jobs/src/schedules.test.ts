import { describe, expect, it, vi } from 'vitest';

import type { DurableJobQueue } from './queue.js';
import { jobNames } from './names.js';
import { ensureRecurringSchedules } from './schedules.js';

describe('global recurring schedules', () => {
  it('runs the bounded payment-recovery review hourly in UTC', async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);

    await ensureRecurringSchedules(
      { schedule } as unknown as DurableJobQueue,
      []
    );

    expect(schedule).toHaveBeenCalledWith(
      jobNames.paymentRecoveryReconcile,
      '15 * * * *',
      {},
      {
        key: jobNames.paymentRecoveryReconcile,
        tz: 'UTC',
        missed: 'once',
        singletonKey: jobNames.paymentRecoveryReconcile
      }
    );
  });
});
