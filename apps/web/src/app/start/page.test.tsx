import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import StartPage from './page.js';

describe('AccountPulse Solo start page', () => {
  it('keeps beta access invite-only and signs invited customers into onboarding', () => {
    const markup = renderToStaticMarkup(<StartPage />);

    expect(markup).toContain(
      'href="/auth/login?returnTo=%2Fonboarding"'
    );
    expect(markup).toContain('Request beta access');
    expect(markup).toContain('mailto:ap@motts.com.au');
    expect(markup).toContain('card payment is due during signup');
    expect(markup).toContain('does not include a free trial');
    expect(markup).not.toContain('14-day free trial');
    expect(markup).not.toContain('No card is required');
    expect(markup).not.toContain('mode=signup');
  });

  it('keeps Sign Up with Xero visibly disabled until Xero approval', () => {
    const markup = renderToStaticMarkup(<StartPage />);

    expect(markup).toContain('Sign Up with Xero');
    expect(markup).toContain('Pending Xero approval');
    expect(markup).toContain('disabled');
  });
});
