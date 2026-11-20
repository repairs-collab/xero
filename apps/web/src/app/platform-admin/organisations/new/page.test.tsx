import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const requirePlatformOwnerPage = vi.hoisted(() => vi.fn());

vi.mock('../../../../server/platform-page-authorization.js', () => ({
  requirePlatformOwnerPage
}));

vi.mock('./actions.js', () => ({
  createCustomerAction: vi.fn()
}));

import NewPlatformCustomerPage from './page.js';

describe('platform customer creation page', () => {
  it('creates an unpaid controlled workspace without offering trial controls', async () => {
    requirePlatformOwnerPage.mockResolvedValue(undefined);

    const markup = renderToStaticMarkup(
      await NewPlatformCustomerPage({ searchParams: Promise.resolve({}) })
    );

    expect(markup).toContain('controlled Solo beta workspace');
    expect(markup).toContain('paid subscription is activated');
    expect(markup).toMatch(/name="includedSmsParts"[^>]*value="1000"/);
    expect(markup).not.toContain('name="trialDays"');
    expect(markup).not.toContain('Trial length');
    expect(markup).not.toContain('safe Solo trial');
  });
});
