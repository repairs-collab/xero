import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../server/legal-content.js', () => ({
  legalIdentity: () => ({
    entity: 'Swan Hill Appliance Repairs Pty Ltd',
    supportEmail: 'ap@motts.com.au'
  }),
  legalLastUpdated: '12 November 2026'
}));

import PrivacyPage from './page.js';

describe('AccountPulse Australian privacy policy', () => {
  it('describes the Australian launch and public privacy contact', () => {
    const markup = renderToStaticMarkup(<PrivacyPage />);

    expect(markup).toContain('personal information in Australia');
    expect(markup).toContain('mailto:ap@motts.com.au');
    expect(markup).toContain('K Heaton');
    expect(markup).toContain('five years after account cancellation');
    expect(markup).toContain('within 14 days');
    expect(markup).toContain('Sophiie');
    expect(markup).toContain('OpenAI');
    expect(markup).not.toContain('customers in Australia and New Zealand');
    expect(markup).not.toContain('Privacy Commissioner in New Zealand');
  });
});
