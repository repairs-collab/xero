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
        listAuditEvents: vi.fn(),
        extendTrial: vi.fn(),
        endTrial: vi.fn(),
        suspendOrganisation: vi.fn(),
        reactivateOrganisation: vi.fn()
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
        listAuditEvents: vi.fn(),
        extendTrial: vi.fn(),
        endTrial: vi.fn(),
        suspendOrganisation: vi.fn(),
        reactivateOrganisation: vi.fn()
      }
    });

    await expect(
      service.getOrganisationDetail('customer-admin', 'organisation-1')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('validates trial extensions before calling the repository', async () => {
    const extendTrial = vi.fn();
    const service = createPlatformAdminService({
      verifyOwner: async () => true,
      repository: {
        listOrganisations: vi.fn(),
        getOrganisationDetail: vi.fn(),
        listSmsNumbers: vi.fn(),
        listAuditEvents: vi.fn(),
        extendTrial,
        endTrial: vi.fn(),
        suspendOrganisation: vi.fn(),
        reactivateOrganisation: vi.fn()
      },
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    });

    await expect(
      service.extendTrial('owner-user', {
        organisationId: 'organisation-1',
        newEnd: new Date('2027-03-01T00:00:00.000Z'),
        expectedUpdatedAt: new Date('2026-11-10T00:00:00.000Z'),
        reason: 'Too long'
      })
    ).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    expect(extendTrial).not.toHaveBeenCalled();
  });
});
