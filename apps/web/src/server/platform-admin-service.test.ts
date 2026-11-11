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
      verifyOwner: (userId) => Promise.resolve(userId === 'owner-user'),
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
        verifySmsNumberForPool: vi.fn(),
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
      verifyOwner: () => Promise.resolve(false),
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
        verifySmsNumberForPool: vi.fn(),
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

  it('denies forged platform mutations before any repository call', async () => {
    const repository = {
      listOrganisations: vi.fn(),
      getOrganisationDetail: vi.fn(),
      listSmsNumbers: vi.fn(),
      listAuditEvents: vi.fn(),
      extendTrial: vi.fn(),
      endTrial: vi.fn(),
      suspendOrganisation: vi.fn(),
      reactivateOrganisation: vi.fn(),
      registerSmsNumber: vi.fn(),
      verifySmsNumberForPool: vi.fn(),
      assignSmsNumber: vi.fn(),
      markSmsNumberReady: vi.fn(),
      quarantineSmsNumber: vi.fn(),
      releaseSmsNumber: vi.fn(),
      returnSmsNumberToPool: vi.fn(),
      updateSmsAllowance: vi.fn()
    };
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(false),
      repository
    });

    await expect(
      service.suspendOrganisation('customer-admin', {
        organisationId: 'another-customer',
        expectedVersion: 0,
        reason: 'Forged form submission'
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.registerSmsNumber('customer-admin', {
        e164Number: '+61400000000',
        providerNumberId: null,
        reason: 'Forged form submission'
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.updateSmsAllowance('customer-admin', {
        organisationId: 'another-customer',
        includedParts: 999_999,
        warningPercent: 100,
        expectedUpdatedAt: null,
        reason: 'Forged form submission'
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(repository.suspendOrganisation).not.toHaveBeenCalled();
    expect(repository.registerSmsNumber).not.toHaveBeenCalled();
    expect(repository.updateSmsAllowance).not.toHaveBeenCalled();
  });

  it('validates trial extensions before calling the repository', async () => {
    const extendTrial = vi.fn();
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
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
        verifySmsNumberForPool: vi.fn(),
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
      verifyOwner: () => Promise.resolve(true),
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
      expectedUpdatedAt: new Date('2026-11-10T00:00:00.000Z'),
      reason: ' Plan change '
    })).resolves.toEqual({ ok: true, value: {} });
    expect(registerSmsNumber).not.toHaveBeenCalled();
    expect(updateSmsAllowance).toHaveBeenCalledWith({
      actorUserId: 'owner-user',
      organisationId: 'organisation-1',
      includedParts: 2_500,
      warningPercent: 85,
      expectedUpdatedAt: new Date('2026-11-10T00:00:00.000Z'),
      reason: 'Plan change',
      now: new Date('2026-11-11T00:00:00.000Z')
    });
  });

  it('requires explicit owner confirmation before verifying a number for automatic allocation', async () => {
    const verifySmsNumberForPool = vi
      .fn()
      .mockResolvedValue({ ok: true, value: {} });
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
      repository: { verifySmsNumberForPool } as never,
      clock: { now: () => new Date('2026-11-11T01:00:00.000Z') }
    });
    const input = {
      numberId: 'number-1',
      expectedUpdatedAt: new Date('2026-11-10T00:00:00.000Z'),
      providerNumberId: ' sinch-number-1 ',
      reason: ' Ownership and message tests passed ',
      verificationConfirmed: false
    };

    await expect(
      service.verifySmsNumberForPool('owner-user', input)
    ).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    expect(verifySmsNumberForPool).not.toHaveBeenCalled();

    await expect(
      service.verifySmsNumberForPool('owner-user', {
        ...input,
        verificationConfirmed: true
      })
    ).resolves.toEqual({ ok: true, value: {} });
    expect(verifySmsNumberForPool).toHaveBeenCalledWith({
      actorUserId: 'owner-user',
      numberId: 'number-1',
      expectedUpdatedAt: new Date('2026-11-10T00:00:00.000Z'),
      providerNumberId: 'sinch-number-1',
      reason: 'Ownership and message tests passed',
      now: new Date('2026-11-11T01:00:00.000Z')
    });
  });
});
