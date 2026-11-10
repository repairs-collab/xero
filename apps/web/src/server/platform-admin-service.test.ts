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
        reactivateOrganisation: vi.fn(),
        registerSmsNumber: vi.fn(),
        assignSmsNumber: vi.fn(),
        markSmsNumberReady: vi.fn(),
        quarantineSmsNumber: vi.fn(),
        releaseSmsNumber: vi.fn(),
        returnSmsNumberToPool: vi.fn(),
        updateSmsAllowance: vi.fn()
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
        reactivateOrganisation: vi.fn(),
        registerSmsNumber: vi.fn(),
        assignSmsNumber: vi.fn(),
        markSmsNumberReady: vi.fn(),
        quarantineSmsNumber: vi.fn(),
        releaseSmsNumber: vi.fn(),
        returnSmsNumberToPool: vi.fn(),
        updateSmsAllowance: vi.fn()
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
        reactivateOrganisation: vi.fn(),
        registerSmsNumber: vi.fn(),
        assignSmsNumber: vi.fn(),
        markSmsNumberReady: vi.fn(),
        quarantineSmsNumber: vi.fn(),
        releaseSmsNumber: vi.fn(),
        returnSmsNumberToPool: vi.fn(),
        updateSmsAllowance: vi.fn()
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

  it('validates and normalizes number and allowance mutations before persistence', async () => {
    const registerSmsNumber = vi.fn();
    const updateSmsAllowance = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const repository = {
      registerSmsNumber,
      updateSmsAllowance
    } as never;
    const service = createPlatformAdminService({
      verifyOwner: async () => true,
      repository,
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    });

    await expect(service.registerSmsNumber('owner-user', {
      e164Number: '0400000000',
      providerNumberId: ' provider-1 ',
      reason: ' Add number '
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    await expect(service.updateSmsAllowance('owner-user', {
      organisationId: 'organisation-1',
      includedParts: 2_500,
      warningPercent: 85,
      reason: ' Plan change '
    })).resolves.toEqual({ ok: true, value: {} });
    expect(registerSmsNumber).not.toHaveBeenCalled();
    expect(updateSmsAllowance).toHaveBeenCalledWith({
      actorUserId: 'owner-user',
      organisationId: 'organisation-1',
      includedParts: 2_500,
      warningPercent: 85,
      reason: 'Plan change',
      now: new Date('2026-11-11T00:00:00.000Z')
    });
  });
});
