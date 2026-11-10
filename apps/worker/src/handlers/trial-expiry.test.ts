import { describe, expect, it, vi } from 'vitest';

import { processTrialExpiry } from './trial-expiry.js';

const now = new Date('2026-11-10T00:00:00.000Z');

describe('processTrialExpiry', () => {
  it('pauses sending, disconnects Xero and records 30-day retention for an expired trial', async () => {
    const pauseScheduledWork = vi.fn(() => Promise.resolve());
    const disconnectXero = vi.fn(() => Promise.resolve());
    const recordRetentionDeadline = vi.fn(() => Promise.resolve());

    await expect(
      processTrialExpiry(
        {
          load: () =>
            Promise.resolve({
              status: 'TRIALING',
              trialEndsAt: new Date('2026-11-09T23:59:59.000Z'),
              retentionDeadlineRecorded: false
            }),
          pauseScheduledWork,
          disconnectXero,
          recordRetentionDeadline,
          clock: { now: () => now }
        },
        { organisationId: 'org_solo' }
      )
    ).resolves.toBe('DISCONNECTED');
    expect(pauseScheduledWork).toHaveBeenCalledWith('org_solo', now);
    expect(disconnectXero).toHaveBeenCalledWith('org_solo');
    expect(recordRetentionDeadline).toHaveBeenCalledWith({
      organisationId: 'org_solo',
      disconnectedAt: now,
      retentionDeadline: new Date('2026-12-10T00:00:00.000Z')
    });
  });

  it('is stale before expiry or after conversion and idempotent after retention is recorded', async () => {
    const sideEffect = vi.fn(() => Promise.resolve());
    const dependencies = {
      pauseScheduledWork: sideEffect,
      disconnectXero: sideEffect,
      recordRetentionDeadline: sideEffect,
      clock: { now: () => now }
    };
    await expect(
      processTrialExpiry(
        {
          ...dependencies,
          load: () =>
            Promise.resolve({
              status: 'TRIALING',
              trialEndsAt: new Date('2026-11-11T00:00:00.000Z'),
              retentionDeadlineRecorded: false
            })
        },
        { organisationId: 'org_future' }
      )
    ).resolves.toBe('STALE');
    await expect(
      processTrialExpiry(
        {
          ...dependencies,
          load: () =>
            Promise.resolve({
              status: 'ACTIVE',
              trialEndsAt: null,
              retentionDeadlineRecorded: false
            })
        },
        { organisationId: 'org_paid' }
      )
    ).resolves.toBe('STALE');
    await expect(
      processTrialExpiry(
        {
          ...dependencies,
          load: () =>
            Promise.resolve({
              status: 'TRIALING',
              trialEndsAt: new Date('2026-11-01T00:00:00.000Z'),
              retentionDeadlineRecorded: true
            })
        },
        { organisationId: 'org_applied' }
      )
    ).resolves.toBe('ALREADY_APPLIED');
    expect(sideEffect).not.toHaveBeenCalled();
  });
});
