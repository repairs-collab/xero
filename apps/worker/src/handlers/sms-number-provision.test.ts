import { describe, expect, it, vi } from 'vitest';

import { provisionPaidSmsNumber } from './sms-number-provision.js';

describe('paid SMS reply number provisioning', () => {
  it('reserves one provider-owned number and records readiness evidence', async () => {
    const markNumberReady = vi.fn(() => Promise.resolve());
    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            reserveAvailableNumber: () =>
              Promise.resolve({
                id: 'number-1',
                e164Number: '+61400000009',
                status: 'RESERVED' as const
              }),
            markNumberReady
          },
          clock: { now: () => new Date('2026-11-10T00:00:00.000Z') }
        },
        { organisationId: 'organisation-1' }
      )
    ).resolves.toBe('READY');
    expect(markNumberReady).toHaveBeenCalledWith(
      'organisation-1',
      'number-1',
      new Date('2026-11-10T00:00:00.000Z')
    );
  });

  it('is idempotent when the number is already ready', async () => {
    const markNumberReady = vi.fn();
    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            reserveAvailableNumber: () =>
              Promise.resolve({
                id: 'number-1',
                e164Number: '+61400000009',
                status: 'READY' as const
              }),
            markNumberReady
          },
          clock: { now: () => new Date() }
        },
        { organisationId: 'organisation-1' }
      )
    ).resolves.toBe('ALREADY_READY');
    expect(markNumberReady).not.toHaveBeenCalled();
  });
});
