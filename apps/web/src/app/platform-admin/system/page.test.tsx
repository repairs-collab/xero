import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformOwnerPage: vi.fn().mockResolvedValue({
    userId: 'verified-owner',
    displayName: 'Owner',
    memberships: []
  }),
  loadServerHealthSnapshot: vi.fn().mockResolvedValue({
    status: 'UNAVAILABLE',
    checkedAt: null,
    ageSeconds: null,
    message: 'Server health data is not available.',
    host: null,
    memory: null,
    disk: null,
    services: []
  })
}));

vi.mock('../../../server/platform-page-authorization.js', () => ({
  requirePlatformOwnerPage: mocks.requirePlatformOwnerPage
}));

vi.mock('../../../server/server-health.js', () => ({
  loadServerHealthSnapshot: mocks.loadServerHealthSnapshot
}));

import PlatformServerHealthPage from './page.js';

describe('platform owner server health page', () => {
  it('authorizes the owner route before loading and rendering the safe snapshot', async () => {
    const element = await PlatformServerHealthPage();
    const html = renderToStaticMarkup(element);

    expect(mocks.requirePlatformOwnerPage).toHaveBeenCalledWith(
      '/platform-admin/system'
    );
    expect(mocks.loadServerHealthSnapshot).toHaveBeenCalledOnce();
    expect(html).toContain('Server health data is not available.');
  });
});

