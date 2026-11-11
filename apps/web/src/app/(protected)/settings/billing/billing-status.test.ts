import { describe, expect, it } from 'vitest';
import type { BillingAccount } from '../../../../server/subscription-service.js';
import { billingStatus } from './billing-status.js';

const now = new Date('2026-11-10T00:00:00Z');
const account = { status: 'CANCEL_AT_PERIOD_END', stripeProviderStatus: 'active', currentPeriodEnd: now, cancelAt: null } as BillingAccount;
describe('billing scheduled cancellation display', () => {
  it('shows ended subscription and renewal guidance at the paid boundary', () => {
    expect(billingStatus(account, now)).toEqual({ status: 'CANCELLED', warning: 'ended' });
  });
  it('treats missing provenance as incomplete', () => {
    expect(billingStatus({ ...account, stripeProviderStatus: null }, now)).toEqual({ status: 'INCOMPLETE', warning: 'payment' });
  });
  it('keeps a verified subscription active before the boundary', () => {
    expect(billingStatus(account, new Date(now.getTime() - 1))).toEqual({ status: 'CANCEL_AT_PERIOD_END', warning: 'none' });
  });
});
