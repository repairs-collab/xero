import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SmsIssuesView } from '../src/app/(protected)/sms-issues/sms-issues-view.js';

describe('SMS issues view', () => {
  it('separates fixable contact issues from compliance blocks', () => {
    const html = renderToStaticMarkup(
      <SmsIssuesView
        sections={{
          contactDetailsNeeded: [
            {
              customerId: 'customer-1',
              customerName: 'Alex Customer',
              email: 'alex@example.invalid',
              reason: 'NO_USABLE_MOBILE',
              destination: null,
              invoices: [
                {
                  id: 'invoice-1',
                  invoiceNumber: 'INV-5000',
                  amountDue: '125.5000',
                  currency: 'AUD',
                  dueDate: '2026-08-31'
                }
              ]
            }
          ],
          complianceBlocked: [
            {
              customerId: 'customer-2',
              customerName: 'Casey Customer',
              email: null,
              reason: 'SMS_SUPPRESSED',
              destination: '+61400000002',
              invoices: [
                {
                  id: 'invoice-2',
                  invoiceNumber: 'INV-5001',
                  amountDue: '80.0000',
                  currency: 'AUD',
                  dueDate: '2026-09-01'
                }
              ]
            }
          ]
        }}
      />
    );

    expect(html).toContain('SMS Issues');
    expect(html).toContain('Contact details needed');
    expect(html).toContain('Compliance blocked');
    expect(html).toContain('Fix client details');
    expect(html).toContain('/customers/customer-1?editPhone=1#sms-phone');
    expect(html).toContain('/invoices/invoice-1');
    expect(html).toContain('STOP received or another active suppression');
    expect(html).not.toContain('Override suppression');
  });
});
