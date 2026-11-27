import { describe, expect, it, vi } from 'vitest';

import { jobNames, type JobName } from './names.js';
import { ensureRecurringSchedules } from './schedules.js';

describe('global recurring schedules', () => {
  it('runs the bounded payment-recovery review hourly in UTC', async () => {
    const schedule = vi.fn<(name: JobName) => Promise<void>>().mockResolvedValue(undefined);
    await ensureRecurringSchedules({ schedule }, []);
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

  it('keeps usage billing scheduled without recurring dedicated-number requests', async () => {
    const schedule = vi.fn<(name: JobName) => Promise<void>>().mockResolvedValue(undefined);
    await ensureRecurringSchedules({ schedule }, []);
    const scheduledJobs = schedule.mock.calls.map(([name]) => name);
    expect(scheduledJobs).toContain(jobNames.smsOverageInvoiceReconcile);
    expect(scheduledJobs).not.toContain(jobNames.smsNumberProvisionReconcile);
  });
});
