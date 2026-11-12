import { describe, expect, it, vi } from 'vitest';

import { provisionPaidSmsNumber } from './sms-number-provision.js';

const now = new Date('2026-11-12T02:30:00.000Z');

const request = {
  id: 'request-1',
  organisationId: 'organisation-1',
  provider: 'SINCH',
  requestKey: 'reply-number:organisation-1:1',
  attempt: 1,
  version: 1,
  status: 'AWAITING_QUOTE' as const,
  quoteSetupFeeMinor: null,
  quoteMonthlyFeeMinor: null,
  quoteCurrency: null,
  quoteExpiresAt: null,
  quotedAt: null,
  documentationStatus: 'UNKNOWN' as const,
  documentationEvidenceReference: null,
  approvedByUserId: null,
  approvedAt: null,
  approvalReason: null,
  externalOrderReference: null,
  manualOrderRecordedAt: null,
  fulfilledNumberId: null,
  failureCode: null,
  failedAt: null,
  expiredAt: null,
  createdAt: now,
  updatedAt: now
};

describe('paid SMS reply number provisioning', () => {
  it('completes without mutations when an assigned number is already ready', async () => {
    const ensureRequestForPaidOrganisation = vi.fn();

    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            loadOrganisationProvisioningState: () =>
              Promise.resolve({
                kind: 'ASSIGNED_READY' as const,
                numberId: 'number-1',
                e164Number: '+61400000009'
              }),
            ensureRequestForPaidOrganisation
          },
          clock: { now: () => now }
        },
        { organisationId: 'organisation-1' }
      )
    ).resolves.toBe('ALREADY_READY');
    expect(ensureRequestForPaidOrganisation).not.toHaveBeenCalled();
  });

  it('completes as awaiting verification for an assigned reserved number', async () => {
    const ensureRequestForPaidOrganisation = vi.fn();

    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            loadOrganisationProvisioningState: () =>
              Promise.resolve({
                kind: 'ASSIGNED_RESERVED' as const,
                numberId: 'number-1',
                e164Number: '+61400000009'
              }),
            ensureRequestForPaidOrganisation
          },
          clock: { now: () => now }
        },
        { organisationId: 'organisation-1' }
      )
    ).resolves.toBe('AWAITING_VERIFICATION');
    expect(ensureRequestForPaidOrganisation).not.toHaveBeenCalled();
  });

  it('completes with owner action required for an assigned quarantined number', async () => {
    const ensureRequestForPaidOrganisation = vi.fn();

    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            loadOrganisationProvisioningState: () =>
              Promise.resolve({
                kind: 'ASSIGNED_QUARANTINED' as const,
                numberId: 'number-1',
                e164Number: '+61400000009'
              }),
            ensureRequestForPaidOrganisation
          },
          clock: { now: () => now }
        },
        { organisationId: 'organisation-1' }
      )
    ).resolves.toBe('OWNER_ACTION_REQUIRED');
    expect(ensureRequestForPaidOrganisation).not.toHaveBeenCalled();
  });

  it('idempotently preserves an existing active manual request', async () => {
    const ensureRequestForPaidOrganisation = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: request })
    );

    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            loadOrganisationProvisioningState: () =>
              Promise.resolve({
                kind: 'ACTIVE_REQUEST' as const,
                requestId: request.id,
                status: request.status
              }),
            ensureRequestForPaidOrganisation
          },
          clock: { now: () => now }
        },
        { organisationId: 'organisation-1' }
      )
    ).resolves.toBe('OWNER_ACTION_REQUIRED');
    expect(ensureRequestForPaidOrganisation).toHaveBeenCalledWith({
      organisationId: 'organisation-1',
      provider: 'SINCH',
      now
    });
  });

  it('creates the manual control-plane request when no number or request exists', async () => {
    const ensureRequestForPaidOrganisation = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: request })
    );

    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            loadOrganisationProvisioningState: () =>
              Promise.resolve({ kind: 'NONE' as const }),
            ensureRequestForPaidOrganisation
          },
          clock: { now: () => now }
        },
        { organisationId: 'organisation-1' }
      )
    ).resolves.toBe('OWNER_ACTION_REQUIRED');
    expect(ensureRequestForPaidOrganisation).toHaveBeenCalledWith({
      organisationId: 'organisation-1',
      provider: 'SINCH',
      now
    });
  });

  it('does not report owner action when strict paid eligibility rejects the request', async () => {
    await expect(
      provisionPaidSmsNumber(
        {
          repository: {
            loadOrganisationProvisioningState: () =>
              Promise.resolve({ kind: 'NONE' as const }),
            ensureRequestForPaidOrganisation: () =>
              Promise.resolve({ ok: false as const, code: 'NOT_ELIGIBLE' as const })
          },
          clock: { now: () => now }
        },
        { organisationId: 'organisation-1' }
      )
    ).rejects.toThrow('REPLY_NUMBER_PROVISIONING_NOT_ELIGIBLE');
  });
});
