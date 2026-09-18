import { describe, expect, it } from 'vitest';

import { evaluateEligibility } from './eligibility.js';

const base = {
  type: 'ACCREC' as const,
  status: 'AUTHORISED' as const,
  amountDue: '120.00',
  contactActive: true,
  invoicePaused: false,
  customerPaused: false,
  sequencePaused: false,
  channelUsable: true,
  channelSuppressed: false,
  stageCompleted: false
};

describe('evaluateEligibility', () => {
  it('accepts an authorised receivable with a balance', () => {
    expect(evaluateEligibility(base)).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    ['paid balance', { amountDue: '0.00' }, 'NO_BALANCE'],
    ['supplier bill', { type: 'ACCPAY' as const }, 'NOT_ACCREC'],
    ['opted-out number', { channelSuppressed: true }, 'CHANNEL_SUPPRESSED'],
    ['customer pause', { customerPaused: true }, 'CUSTOMER_PAUSED']
  ])('rejects %s', (_label, patch, reason) => {
    expect(evaluateEligibility({ ...base, ...patch })).toEqual({
      eligible: false,
      reasons: [reason]
    });
  });
});
