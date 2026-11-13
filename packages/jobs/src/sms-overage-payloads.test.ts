import { describe, expect, it } from 'vitest';

import { jobNames } from './names.js';
import { parseJobPayload } from './payloads.js';

describe('SMS overage billing job contract', () => {
  it('publishes a global reconciliation job with an empty payload', () => {
    expect(jobNames.smsOverageInvoiceReconcile).toBe(
      'sms-overage.invoice-reconcile'
    );
    expect(
      parseJobPayload(jobNames.smsOverageInvoiceReconcile, {})
    ).toEqual({});
    expect(() =>
      parseJobPayload(jobNames.smsOverageInvoiceReconcile, {
        organisationId: 'forged'
      })
    ).toThrow();
  });
});
