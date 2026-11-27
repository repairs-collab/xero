import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformOwnerPage: vi.fn().mockResolvedValue({
    userId: 'verified-owner', displayName: 'Owner', memberships: []
  }),
  getSnapshot: vi.fn().mockResolvedValue({
    metrics: { pendingOrRetry: 0, unknown: 0, failedLast24Hours: 0, sentLast24Hours: 0 }, rows: []
  })
}));

vi.mock('../../../server/platform-page-authorization.js', () => ({
  requirePlatformOwnerPage: mocks.requirePlatformOwnerPage
}));
vi.mock('../../../server/platform-email-monitoring-service.js', () => ({
  getPlatformEmailMonitoringService: () => ({ getSnapshot: mocks.getSnapshot })
}));

import PlatformEmailPage from './page.js';

describe('platform owner email page', () => {
  it('authorizes the exact route and passes only the verified owner identity to the service', async () => {
    const html = renderToStaticMarkup(await PlatformEmailPage());
    expect(mocks.requirePlatformOwnerPage).toHaveBeenCalledWith('/platform-admin/email');
    expect(mocks.getSnapshot).toHaveBeenCalledWith('verified-owner');
    expect(html).toContain('Email delivery');
  });
});
