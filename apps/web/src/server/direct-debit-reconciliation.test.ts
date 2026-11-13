import { describe, expect, it } from 'vitest';

import { parseDirectDebitProviderReference } from './direct-debit-reconciliation.js';

describe('direct-debit provider reconciliation reference', () => {
  it.each([
    'cus_customer123|sub_subscription123|pm_payment123',
    'cus_customer-123|sub_subscription-123|pm_payment-123',
    'cus_customer123|sub_subscription123|none'
  ])('accepts bounded opaque Stripe object context: %s', (value) => {
    expect(parseDirectDebitProviderReference(value)).toBe(value);
  });

  it.each([
    '',
    'cus_customer123|sub_subscription123|4242424242424242',
    'cus_customer123|sub_subscription123|pm_payment 123',
    'cus_customer123|sub_subscription123|pm_payment123\nnotes',
    'customer123|subscription123|payment123',
    `cus_${'a'.repeat(121)}|sub_subscription123|none`
  ])('rejects free text, payment data, or an unbounded value: %s', (value) => {
    expect(() => parseDirectDebitProviderReference(value)).toThrow(
      'DIRECT_DEBIT_RECONCILIATION_REFERENCE_REQUIRED'
    );
  });
});
