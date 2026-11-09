import { describe, expect, it } from 'vitest';

import { processSubscriptionLifecycle } from './subscription-lifecycle.js';

describe('processSubscriptionLifecycle', () => {
  it('disconnects Xero and records a 30-day retention deadline after cancellation', async () => {
    const disconnected: string[] = [];
    const records: Array<{
      organisationId: string;
      disconnectedAt: Date;
      retentionDeadline: Date;
    }> = [];

    await expect(
      processSubscriptionLifecycle(
        {
          load: () =>
            Promise.resolve({
              status: 'CANCELLED',
              retentionDeadlineRecorded: false
            }),
          disconnectXero: (organisationId) => {
            disconnected.push(organisationId);
            return Promise.resolve();
          },
          quarantineSmsNumber: () => Promise.resolve(),
          recordRetentionDeadline: (input) => {
            records.push(input);
            return Promise.resolve();
          },
          clock: { now: () => new Date('2026-11-09T12:00:00.000Z') }
        },
        { organisationId: 'org_solo', status: 'CANCELLED' }
      )
    ).resolves.toBe('DISCONNECTED');

    expect(disconnected).toEqual(['org_solo']);
    expect(records).toEqual([
      {
        organisationId: 'org_solo',
        disconnectedAt: new Date('2026-11-09T12:00:00.000Z'),
        retentionDeadline: new Date('2026-12-09T12:00:00.000Z')
      }
    ]);
  });

  it('does not disconnect for scheduled cancellation or a stale job', async () => {
    let disconnects = 0;
    const result = await processSubscriptionLifecycle(
      {
        load: () =>
          Promise.resolve({
            status: 'CANCEL_AT_PERIOD_END',
            retentionDeadlineRecorded: false
          }),
        disconnectXero: () => {
          disconnects += 1;
          return Promise.resolve();
        },
        quarantineSmsNumber: () => Promise.resolve(),
        recordRetentionDeadline: () => Promise.resolve(),
        clock: { now: () => new Date('2026-11-09T12:00:00.000Z') }
      },
      { organisationId: 'org_solo', status: 'CANCELLED' }
    );

    expect(result).toBe('STALE');
    expect(disconnects).toBe(0);
  });

  it('is idempotent after the retention deadline was recorded', async () => {
    let disconnects = 0;
    const result = await processSubscriptionLifecycle(
      {
        load: () =>
          Promise.resolve({
            status: 'CANCELLED',
            retentionDeadlineRecorded: true
          }),
        disconnectXero: () => {
          disconnects += 1;
          return Promise.resolve();
        },
        quarantineSmsNumber: () => Promise.resolve(),
        recordRetentionDeadline: () => Promise.resolve(),
        clock: { now: () => new Date('2026-11-09T12:00:00.000Z') }
      },
      { organisationId: 'org_solo', status: 'CANCELLED' }
    );

    expect(result).toBe('ALREADY_APPLIED');
    expect(disconnects).toBe(0);
  });
});
