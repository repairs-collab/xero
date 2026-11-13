import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformOwnerPage: vi.fn().mockResolvedValue({
    userId: 'verified-owner',
    displayName: 'Owner',
    memberships: []
  }),
  listOperations: vi.fn().mockResolvedValue({
    retentionCases: [],
    dataRequests: []
  })
}));

vi.mock('../../../server/platform-page-authorization.js', () => ({
  requirePlatformOwnerPage: mocks.requirePlatformOwnerPage
}));

vi.mock('../../../server/retention-operations-runtime.js', () => ({
  getRetentionOperationsService: () => ({
    listOperations: mocks.listOperations
  })
}));

vi.mock('./actions.js', () => ({
  completeExportRequestAction: vi.fn(),
  recordBackupExpiryVerificationAction: vi.fn(),
  recordVerifiedRequestAction: vi.fn(),
  reviewDataRequestAction: vi.fn()
}));

import PlatformRetentionPage from './page.js';

describe('platform retention owner page', () => {
  it('authorizes the page and keeps an exact tenant filter on the owner query', async () => {
    const element = await PlatformRetentionPage({
      searchParams: Promise.resolve({
        organisationId: '11111111-1111-4111-8111-111111111111',
        result: 'UPDATED'
      })
    });
    const html = renderToStaticMarkup(element);

    expect(mocks.requirePlatformOwnerPage).toHaveBeenCalledWith(
      '/platform-admin/retention'
    );
    expect(mocks.listOperations).toHaveBeenCalledWith('verified-owner', {
      organisationId: '11111111-1111-4111-8111-111111111111'
    });
    expect(html).toContain('Retention &amp; privacy requests');
    expect(html).toContain('Retention work item updated.');
  });
});
