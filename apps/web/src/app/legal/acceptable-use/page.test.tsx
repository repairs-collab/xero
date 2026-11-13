import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../server/legal-content.js', () => ({
  legalIdentity: () => ({
    supportEmail: 'ap@motts.com.au',
    complaintsEmail: 'info@motts.com.au'
  }),
  legalLastUpdated: '12 November 2026'
}));

import AcceptableUsePage from './page.js';

describe('AccountPulse debt-reminder contact policy', () => {
  it('publishes the approved contact limits and recipient safeguards', () => {
    const markup = renderToStaticMarkup(<AcceptableUsePage />);

    expect(markup).toContain('8:30am–5:00pm Australia/Sydney');
    expect(markup).toContain('one outbound debt-reminder contact per day');
    expect(markup).toContain('STOP');
    expect(markup).toContain('manually mark disputed invoices');
    expect(markup).toContain('Inbound calls may be recorded only after clear notice');
    expect(markup).toContain('K Heaton');
    expect(markup).toContain('mailto:info@motts.com.au');
  });
});
