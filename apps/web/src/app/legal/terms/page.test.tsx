import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../server/legal-content.js', () => ({
  legalIdentity: () => ({
    entity: 'Swan Hill Appliance Repairs Pty Ltd',
    supportEmail: 'AP@motts.com.au'
  }),
  legalLastUpdated: '11 November 2026',
  termsLastUpdated: '12 November 2026'
}));

import TermsPage from './page.js';

describe('AccountPulse Terms SMS allowance', () => {
  it('describes the hard cap without promising paid overage', () => {
    const markup = renderToStaticMarkup(<TermsPage />);

    expect(markup).toContain('Last updated: 12 November 2026');
    expect(markup).toContain(
      'Sends that would exceed the included SMS allowance are blocked'
    );
    expect(markup).toContain('Blocked sends are not automatically replayed');
    expect(markup).not.toMatch(/overage/i);
  });
});
