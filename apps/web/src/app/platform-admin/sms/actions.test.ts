import { describe, expect, it, vi } from 'vitest';

import {
  createSmsAdminActions,
  parseAudMinor,
  parseSydneyLocalDate
} from './actions.js';

describe('platform SMS administration actions', () => {
  it('parses bounded AUD decimal values without floating-point rounding', () => {
    expect(parseAudMinor('0')).toBe(0);
    expect(parseAudMinor('11.35')).toBe(1_135);
    expect(parseAudMinor('15.3')).toBe(1_530);
    expect(parseAudMinor('21474836.47')).toBe(2_147_483_647);
    expect(() => parseAudMinor('1.005')).toThrow('invalid');
    expect(() => parseAudMinor('1e2')).toThrow('invalid');
    expect(() => parseAudMinor('21474836.48')).toThrow('invalid');
  });

  it('requires an explicit Sydney offset when converting a local quote expiry', () => {
    expect(parseSydneyLocalDate('2026-11-30T10:00', '+11:00')).toEqual(
      new Date('2026-11-29T23:00:00.000Z')
    );
    expect(parseSydneyLocalDate('2026-06-30T10:00', '+10:00')).toEqual(
      new Date('2026-06-30T00:00:00.000Z')
    );
    expect(() =>
      parseSydneyLocalDate('2026-11-30T10:00', '+09:00')
    ).toThrow('invalid');
  });

  it('uses the verified owner identity and parses allowance limits', async () => {
    const updateSmsAllowance = vi.fn().mockResolvedValue({
      ok: true,
      value: { includedParts: 2_000, warningPercent: 80 }
    });
    const actions = createSmsAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { updateSmsAllowance } as never,
      revalidate: vi.fn()
    });
    const form = new FormData();
    form.set('organisationId', 'organisation-1');
    form.set('includedParts', '2000');
    form.set('warningPercent', '80');
    form.set('reason', 'Customer plan changed');
    form.set('actorUserId', 'untrusted-user');

    await expect(actions.updateSmsAllowanceAction(form)).resolves.toEqual({
      ok: true,
      code: 'UPDATED'
    });
    expect(updateSmsAllowance).toHaveBeenCalledWith('verified-owner', {
      organisationId: 'organisation-1',
      includedParts: 2_000,
      warningPercent: 80,
      expectedUpdatedAt: null,
      reason: 'Customer plan changed'
    });
  });

  it('uses the verified owner identity for pool verification and ignores a forged actor', async () => {
    const verifySmsNumberForPool = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'number-1' }
    });
    const revalidate = vi.fn();
    const actions = createSmsAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { verifySmsNumberForPool } as never,
      revalidate
    });
    const form = new FormData();
    form.set('numberId', 'number-1');
    form.set('expectedUpdatedAt', '2026-11-10T00:00:00.000Z');
    form.set('providerNumberId', 'sinch-number-1');
    form.set('reason', 'Ownership and messaging verified');
    form.set('verificationConfirmed', 'on');
    form.set('actorUserId', 'untrusted-user');

    await expect(actions.verifySmsNumberForPoolAction(form)).resolves.toEqual({
      ok: true,
      code: 'UPDATED'
    });
    expect(verifySmsNumberForPool).toHaveBeenCalledWith('verified-owner', {
      numberId: 'number-1',
      expectedUpdatedAt: new Date('2026-11-10T00:00:00.000Z'),
      providerNumberId: 'sinch-number-1',
      reason: 'Ownership and messaging verified',
      verificationConfirmed: true
    });
    expect(revalidate).toHaveBeenCalledWith('/platform-admin/sms');
  });

  it('records a written quote using parsed AUD minor units and the verified owner', async () => {
    const recordReplyNumberQuote = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: '33333333-3333-4333-8333-333333333333' }
    });
    const actions = createSmsAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: '11111111-1111-4111-8111-111111111111',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { recordReplyNumberQuote } as never,
      revalidate: vi.fn()
    });
    const form = new FormData();
    form.set('organisationId', '22222222-2222-4222-8222-222222222222');
    form.set('requestId', '33333333-3333-4333-8333-333333333333');
    form.set('expectedVersion', '1');
    form.set('setupFeeAud', '11.35');
    form.set('monthlyFeeAud', '15.30');
    form.set('quoteExpiresLocal', '2026-11-30T10:00');
    form.set('quoteUtcOffset', '+11:00');
    form.set('documentationStatus', 'REQUIRED');
    form.set('documentationEvidenceReference', 'sinch-case-redacted');
    form.set('reason', 'Written quote received');
    form.set('actorUserId', 'forged-user');

    await expect(actions.recordReplyNumberQuoteAction(form)).resolves.toEqual({
      ok: true,
      code: 'UPDATED'
    });
    expect(recordReplyNumberQuote).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      {
        organisationId: '22222222-2222-4222-8222-222222222222',
        requestId: '33333333-3333-4333-8333-333333333333',
        expectedVersion: 1,
        setupFeeMinor: 1_135,
        monthlyFeeMinor: 1_530,
        quoteExpiresAt: new Date('2026-11-29T23:00:00.000Z'),
        documentationStatus: 'REQUIRED',
        documentationEvidenceReference: 'sinch-case-redacted',
        reason: 'Written quote received'
      }
    );
  });

  it('passes strong exact-cost approval confirmation through to the owner service', async () => {
    const approveManualReplyNumberOrder = vi.fn().mockResolvedValue({
      ok: false,
      code: 'CONFLICT'
    });
    const actions = createSmsAdminActions({
      getOwnerSession: () => Promise.resolve({
        userId: 'verified-owner',
        cognitoSubject: 'owner-subject',
        displayName: 'Owner',
        expiresAt: '2026-12-01T00:00:00.000Z',
        memberships: []
      }),
      service: { approveManualReplyNumberOrder } as never,
      revalidate: vi.fn()
    });
    const form = new FormData();
    form.set('organisationId', '22222222-2222-4222-8222-222222222222');
    form.set('requestId', '33333333-3333-4333-8333-333333333333');
    form.set('expectedVersion', '3');
    form.set('confirmedSetupFeeAud', '11.35');
    form.set('confirmedMonthlyFeeAud', '15.30');
    form.set('approvalConfirmed', 'on');
    form.set('approvalPhrase', 'APPROVE EXACT QUOTE');
    form.set('reason', 'Exact written costs approved');

    await expect(actions.approveManualReplyNumberOrderAction(form)).resolves.toEqual({
      ok: false,
      code: 'CONFLICT'
    });
    expect(approveManualReplyNumberOrder).toHaveBeenCalledWith('verified-owner', {
      organisationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 3,
      confirmedSetupFeeMinor: 1_135,
      confirmedMonthlyFeeMinor: 1_530,
      approvalConfirmed: true,
      approvalPhrase: 'APPROVE EXACT QUOTE',
      reason: 'Exact written costs approved'
    });
  });
});
