import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import StartPage from './page.js';

describe('AccountPulse Solo start page', () => {
  it('starts hosted signup with an explicit onboarding return destination', () => {
    const markup = renderToStaticMarkup(<StartPage />);

    expect(markup).toContain(
      'href="/auth/login?mode=signup&amp;returnTo=%2Fonboarding"'
    );
    expect(markup).toContain('Start free trial');
  });

  it('keeps Sign Up with Xero visibly disabled until Xero approval', () => {
    const markup = renderToStaticMarkup(<StartPage />);

    expect(markup).toContain('Sign Up with Xero');
    expect(markup).toContain('Pending Xero approval');
    expect(markup).toContain('disabled');
  });
});
