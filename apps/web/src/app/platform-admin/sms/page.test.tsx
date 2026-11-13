import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformOwnerPage: vi.fn(),
  listNumbers: vi.fn(),
  listOrganisations: vi.fn(),
  listReplyNumberProvisioningRequests: vi.fn()
}));

vi.mock('../../../server/platform-page-authorization.js', () => ({
  requirePlatformOwnerPage: mocks.requirePlatformOwnerPage
}));

vi.mock('../../../server/platform-admin-service.js', () => ({
  getPlatformAdminService: () => ({
    listNumbers: mocks.listNumbers,
    listOrganisations: mocks.listOrganisations,
    listReplyNumberProvisioningRequests:
      mocks.listReplyNumberProvisioningRequests
  })
}));

vi.mock('./actions.js', () => ({
  approveManualReplyNumberOrderAction: vi.fn(),
  assignSmsNumberAction: vi.fn(),
  completeReplyNumberDocumentationAction: vi.fn(),
  expireReplyNumberProvisioningRequestAction: vi.fn(),
  failReplyNumberProvisioningRequestAction: vi.fn(),
  fulfilReplyNumberProvisioningRequestAction: vi.fn(),
  markSmsNumberReadyAction: vi.fn(),
  quarantineSmsNumberAction: vi.fn(),
  recordManualReplyNumberOrderAction: vi.fn(),
  recordReplyNumberQuoteAction: vi.fn(),
  registerSmsNumberAction: vi.fn(),
  releaseSmsNumberAction: vi.fn(),
  returnSmsNumberToPoolAction: vi.fn(),
  verifySmsNumberForPoolAction: vi.fn()
}));

import PlatformSmsPage from './page.js';

describe('platform SMS owner page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePlatformOwnerPage.mockResolvedValue({
      userId: '11111111-1111-4111-8111-111111111111',
      cognitoSubject: 'owner-subject',
      displayName: 'Owner',
      expiresAt: '2026-12-01T00:00:00.000Z',
      memberships: []
    });
    mocks.listNumbers.mockResolvedValue({
      items: [], total: 0, page: 1, pageSize: 25
    });
    mocks.listOrganisations.mockResolvedValue({
      items: [{
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Alpha Repairs'
      }],
      total: 1,
      page: 1,
      pageSize: 100,
      metrics: { active: 1, suspended: 0, trialing: 0 }
    });
    mocks.listReplyNumberProvisioningRequests.mockResolvedValue({
      items: [], total: 0, page: 1, pageSize: 25
    });
  });

  it('authorizes the page and keeps provisioning filters separate from legacy inventory filters', async () => {
    const element = await PlatformSmsPage({
      searchParams: Promise.resolve({
        provisioningSearch: ' Alpha ',
        provisioningOrganisationId: '22222222-2222-4222-8222-222222222222',
        provisioningStatus: 'AWAITING_OWNER_APPROVAL',
        documentationStatus: 'REQUIRED',
        provisioningPage: '2',
        search: ' +614 ',
        status: 'READY',
        page: '3'
      })
    });
    const html = renderToStaticMarkup(element);

    expect(mocks.requirePlatformOwnerPage).toHaveBeenCalledWith('/platform-admin/sms');
    expect(mocks.listReplyNumberProvisioningRequests).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      {
        search: 'Alpha',
        organisationId: '22222222-2222-4222-8222-222222222222',
        status: 'AWAITING_OWNER_APPROVAL',
        documentationStatus: 'REQUIRED',
        page: 2,
        pageSize: 25
      }
    );
    expect(mocks.listNumbers).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      { search: ' +614 ', status: 'READY', page: 3, pageSize: 25 }
    );
    expect(html).toContain('Manual reply-number provisioning');
  });

  it('does not broaden an invalid provisioning status into an unfiltered owner query', async () => {
    await PlatformSmsPage({
      searchParams: Promise.resolve({ provisioningStatus: 'NOT_A_STATUS' })
    });

    expect(mocks.listReplyNumberProvisioningRequests).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ status: 'NOT_A_STATUS' })
    );
  });
});
