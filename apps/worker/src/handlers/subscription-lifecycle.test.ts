import { describe, expect, it } from 'vitest';

import { processSubscriptionLifecycle } from './subscription-lifecycle.js';

describe('processSubscriptionLifecycle', () => {
  it('records five-year deletion eligibility from the cancellation time while retaining the 30-day review', async () => {
    const disconnected: string[] = [];
    const records: Array<{
      organisationId: string;
      disconnectedAt: Date;
      retentionDeadline: Date;
      deletionEligibleAt: Date | null;
    }> = [];

    await expect(
      processSubscriptionLifecycle(
        {
          load: () =>
            Promise.resolve({
              status: 'CANCELLED',
              cancelledAt: new Date('2026-11-08T09:30:00.000Z'),
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
        retentionDeadline: new Date('2026-12-09T12:00:00.000Z'),
        deletionEligibleAt: new Date('2031-11-08T09:30:00.000Z'),
        closureEffectiveAt: new Date('2026-11-08T09:30:00.000Z')
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
            cancelledAt: null,
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
            cancelledAt: new Date('2026-11-08T09:30:00.000Z'),
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

  it('opens a fresh closure episode for a trusted newer cancellation', async () => {
    const sideEffects: string[] = [];
    const records: Array<{ closureEffectiveAt?: Date }> = [];

    const result = await processSubscriptionLifecycle(
      {
        load: () =>
          Promise.resolve({
            status: 'CANCELLED',
            cancelledAt: new Date('2027-04-10T04:00:00.000Z'),
            retentionDeadlineRecorded: true,
            recordedCancellationAt: new Date('2026-11-08T09:30:00.000Z')
          }),
        disconnectXero: () => {
          sideEffects.push('disconnect-xero');
          return Promise.resolve();
        },
        quarantineSmsNumber: () => {
          sideEffects.push('quarantine-number');
          return Promise.resolve();
        },
        recordRetentionDeadline: (input) => {
          records.push(input);
          return Promise.resolve();
        },
        clock: { now: () => new Date('2027-04-10T05:00:00.000Z') }
      },
      { organisationId: 'org_resubscribed', status: 'CANCELLED' }
    );

    expect(result).toBe('DISCONNECTED');
    expect(sideEffects).toEqual(['quarantine-number', 'disconnect-xero']);
    expect(records).toEqual([
      expect.objectContaining({
        closureEffectiveAt: new Date('2027-04-10T04:00:00.000Z'),
        deletionEligibleAt: new Date('2032-04-10T04:00:00.000Z')
      })
    ]);
  });

  it('uses the last valid anniversary for a leap-day cancellation', async () => {
    let deletionEligibleAt: Date | null = null;
    await processSubscriptionLifecycle(
      {
        load: () =>
          Promise.resolve({
            status: 'CANCELLED',
            cancelledAt: new Date('2028-02-29T09:30:00.000Z'),
            retentionDeadlineRecorded: false
          }),
        disconnectXero: () => Promise.resolve(),
        quarantineSmsNumber: () => Promise.resolve(),
        recordRetentionDeadline: (input) => {
          deletionEligibleAt = input.deletionEligibleAt;
          return Promise.resolve();
        },
        clock: { now: () => new Date('2028-03-01T00:00:00.000Z') }
      },
      { organisationId: 'org_leap_day', status: 'CANCELLED' }
    );

    expect(deletionEligibleAt).toEqual(
      new Date('2033-02-28T09:30:00.000Z')
    );
  });
});
