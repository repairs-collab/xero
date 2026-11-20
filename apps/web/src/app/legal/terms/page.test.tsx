import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../server/legal-content.js', () => ({
  legalIdentity: () => ({
    entity: 'Swan Hill Appliance Repairs Pty Ltd',
    abn: '86 633 952 333',
    acn: '633 952 333',
    address: '3 Cobb Court, Swan Hill VIC 3585',
    supportEmail: 'ap@motts.com.au'
  }),
  legalLastUpdated: '11 November 2026',
  termsLastUpdated: '12 November 2026'
}));

import TermsPage from './page.js';

describe('AccountPulse commercial terms', () => {
  it('describes the confirmed subscription and SMS rules without a free trial', () => {
    const markup = renderToStaticMarkup(<TermsPage />);

    expect(markup).toContain('Last updated: 12 November 2026');
    expect(markup).toContain('86 633 952 333');
    expect(markup).toContain('633 952 333');
    expect(markup).toContain('3 Cobb Court, Swan Hill VIC 3585');
    expect(markup).toContain('first payment is due on signup');
    expect(markup).toContain('5% discount');
    expect(markup).toContain('initial payment must be made by card');
    expect(markup).toContain('Australian BECS Direct Debit');
    expect(markup).toContain('Direct Debit Request');
    expect(markup).toContain('end of the current billing period');
    expect(markup).toContain('do not roll over');
    expect(markup).toContain('including for annually billed subscriptions');
    expect(markup).toContain('30-day payment-recovery period');
    expect(markup).toContain('five years after cancellation');
    expect(markup).toContain('1,000 outbound SMS parts');
    expect(markup).toContain('A$0.11 excluding GST');
    expect(markup).toContain('additional outbound SMS part');
    expect(markup).toContain('does not currently offer a free trial');
    expect(markup).not.toContain('Trial limits');
    expect(markup).toContain('overage');
  });
});
