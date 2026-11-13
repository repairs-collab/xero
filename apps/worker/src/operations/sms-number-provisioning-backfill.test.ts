import { describe, expect, it, vi } from 'vitest';

import { jobNames } from '@bc5000/jobs';

import { backfillPaidSmsNumberProvisioning } from './sms-number-provisioning-backfill.js';

describe('paid SMS number provisioning backfill', () => {
  it('enqueues one stable job per eligible organisation billing period', async () => {
    const publish = vi.fn().mockResolvedValue('job-id');
    const listPaidOrganisationsNeedingProvisioning = vi.fn().mockResolvedValue([
      {
        organisationId: '10000000-0000-4000-8000-000000000001',
        currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z')
      }
    ]);

    await expect(
      backfillPaidSmsNumberProvisioning({
        repository: { listPaidOrganisationsNeedingProvisioning },
        publisher: { publish },
        clock: { now: () => new Date('2026-11-13T02:00:00.000Z') }
      })
    ).resolves.toBe(1);

    expect(listPaidOrganisationsNeedingProvisioning).toHaveBeenCalledWith(
      new Date('2026-11-13T02:00:00.000Z')
    );
    expect(publish).toHaveBeenCalledWith(
      jobNames.smsNumberProvision,
      { organisationId: '10000000-0000-4000-8000-000000000001' },
      {
        singletonKey:
          'sms-number.provision:paid-backfill:10000000-0000-4000-8000-000000000001:2026-11-01T00:00:00.000Z:2026-12-01T00:00:00.000Z',
        deduplicateWhileActive: true
      }
    );
  });

  it('fails startup rather than silently losing an eligible provisioning job', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('queue unavailable'));

    await expect(
      backfillPaidSmsNumberProvisioning({
        repository: {
          listPaidOrganisationsNeedingProvisioning: () =>
            Promise.resolve([
              {
                organisationId: '10000000-0000-4000-8000-000000000002',
                currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
                currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z')
              }
            ])
        },
        publisher: { publish },
        clock: { now: () => new Date('2026-11-13T02:00:00.000Z') }
      })
    ).rejects.toThrow('queue unavailable');
  });
});
