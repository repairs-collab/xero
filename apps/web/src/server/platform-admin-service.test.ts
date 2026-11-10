import { describe, expect, it, vi } from 'vitest';

import { createPlatformAdminService } from './platform-admin-service.js';

describe('platform administration read service', () => {
  it('verifies the owner and normalizes organisation list filters', async () => {
    const listOrganisations = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100
    });
    const service = createPlatformAdminService({
      verifyOwner: async (userId) => userId === 'owner-user',
      repository: {
        listOrganisations,
        getOrganisationDetail: vi.fn(),
        listSmsNumbers: vi.fn(),
        listAuditEvents: vi.fn()
      }
    });

    await service.listOrganisations('owner-user', {
      search: '  Alpha  ',
      page: -2,
      pageSize: 500,
      sort: 'unknown',
      direction: 'sideways'
    });

    expect(listOrganisations).toHaveBeenCalledWith({
      search: 'Alpha',
      page: 1,
      pageSize: 100,
      sort: 'name',
      direction: 'asc'
    });
  });

  it('denies reads when the actor is not a current platform owner', async () => {
    const service = createPlatformAdminService({
      verifyOwner: async () => false,
      repository: {
        listOrganisations: vi.fn(),
        getOrganisationDetail: vi.fn(),
        listSmsNumbers: vi.fn(),
        listAuditEvents: vi.fn()
      }
    });

    await expect(
      service.getOrganisationDetail('customer-admin', 'organisation-1')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
