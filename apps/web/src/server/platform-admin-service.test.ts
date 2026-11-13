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
        listReplyNumberProvisioningRequests: vi.fn(),
        listAuditEvents: vi.fn(),
        listBillingOperations: vi.fn(),
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
        listReplyNumberProvisioningRequests: vi.fn(),
        listAuditEvents: vi.fn(),
        listBillingOperations: vi.fn(),
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

  it('verifies owner access and normalizes the read-only billing queue filters', async () => {
    const listBillingOperations = vi.fn().mockResolvedValue({
      cases: { items: [], nextCursor: null },
      heldEmails: { items: [], nextCursor: null }
    });
    const service = createPlatformAdminService({
      verifyOwner: (userId) => Promise.resolve(userId === 'owner-user'),
      repository: { listBillingOperations } as never
    });

    await service.listBillingOperations('owner-user', {
      organisationId: ' 11111111-1111-4111-8111-111111111111 ',
      caseKind: 'DISPUTE',
      caseStatus: 'OPEN',
      casesCursor: ' cases-cursor ',
      heldEmailsCursor: ' held-cursor ',
      limit: 500
    });

    expect(listBillingOperations).toHaveBeenCalledWith({
      organisationId: '11111111-1111-4111-8111-111111111111',
      caseKind: 'DISPUTE',
      caseStatus: 'OPEN',
      casesCursor: 'cases-cursor',
      heldEmailsCursor: 'held-cursor',
      limit: 100
    });
  });

  it('fails a malformed exact organisation filter closed without broadening the queue', async () => {
    const listBillingOperations = vi.fn();
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
      repository: { listBillingOperations } as never
    });

    await expect(
      service.listBillingOperations('owner-user', {
        organisationId: 'not-a-customer-id'
      })
    ).resolves.toEqual({
      cases: { items: [], nextCursor: null },
      heldEmails: { items: [], nextCursor: null }
    });
    expect(listBillingOperations).not.toHaveBeenCalled();
  });

  it('denies the billing queue before repository access for a non-owner', async () => {
    const listBillingOperations = vi.fn();
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(false),
      repository: { listBillingOperations } as never
    });

    await expect(
      service.listBillingOperations('customer-admin', {})
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listBillingOperations).not.toHaveBeenCalled();
  });

  it('denies forged platform mutations before any repository call', async () => {
    const repository = {
      listOrganisations: vi.fn(),
      getOrganisationDetail: vi.fn(),
      listSmsNumbers: vi.fn(),
      listReplyNumberProvisioningRequests: vi.fn(),
      listAuditEvents: vi.fn(),
      listBillingOperations: vi.fn(),
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
        listReplyNumberProvisioningRequests: vi.fn(),
        listAuditEvents: vi.fn(),
        listBillingOperations: vi.fn(),
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

  it('passes a financial-risk reactivation hold through to its owner caller', async () => {
    const reactivateOrganisation = vi.fn().mockResolvedValue({
      ok: false,
      code: 'BILLING_RISK_HOLD'
    });
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
      repository: { reactivateOrganisation } as never,
      clock: { now: () => new Date('2026-11-11T00:00:00.000Z') }
    });

    await expect(
      service.reactivateOrganisation('owner-user', {
        organisationId: 'organisation-1',
        expectedVersion: 4,
        reason: 'Payment confirmed manually'
      })
    ).resolves.toEqual({ ok: false, code: 'BILLING_RISK_HOLD' });
    expect(reactivateOrganisation).toHaveBeenCalledWith({
      actorUserId: 'owner-user',
      organisationId: 'organisation-1',
      expectedVersion: 4,
      reason: 'Payment confirmed manually',
      now: new Date('2026-11-11T00:00:00.000Z')
    });
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

  it('normalizes reply-number request filters and fails malformed exact customer IDs closed', async () => {
    const listReplyNumberProvisioningRequests = vi.fn().mockResolvedValue({
      items: [], total: 0, page: 1, pageSize: 25
    });
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
      repository: { listReplyNumberProvisioningRequests } as never
    });

    await service.listReplyNumberProvisioningRequests('11111111-1111-4111-8111-111111111111', {
      organisationId: ' 22222222-2222-4222-8222-222222222222 ',
      search: '  Alpha Repairs  ',
      status: 'AWAITING_OWNER_APPROVAL',
      documentationStatus: 'REQUIRED',
      page: -1,
      pageSize: 500
    });

    expect(listReplyNumberProvisioningRequests).toHaveBeenCalledWith({
      organisationId: '22222222-2222-4222-8222-222222222222',
      search: 'Alpha Repairs',
      status: 'AWAITING_OWNER_APPROVAL',
      documentationStatus: 'REQUIRED',
      page: 1,
      pageSize: 100
    });

    listReplyNumberProvisioningRequests.mockClear();
    await expect(service.listReplyNumberProvisioningRequests(
      '11111111-1111-4111-8111-111111111111',
      { organisationId: 'not-a-customer-id' }
    )).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    expect(listReplyNumberProvisioningRequests).not.toHaveBeenCalled();
  });

  it('requires a verified owner and strong exact-cost confirmation for manual ordering', async () => {
    const approveManualOrder = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const provisioningRepository = { approveManualOrder } as never;
    const service = createPlatformAdminService({
      verifyOwner: (userId) => Promise.resolve(userId === '11111111-1111-4111-8111-111111111111'),
      repository: {} as never,
      provisioningRepository,
      clock: { now: () => new Date('2026-11-12T00:00:00.000Z') }
    });
    const input = {
      organisationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 4,
      confirmedSetupFeeMinor: 1_135,
      confirmedMonthlyFeeMinor: 1_530,
      approvalConfirmed: false,
      approvalPhrase: 'APPROVE EXACT QUOTE',
      reason: ' Written costs reviewed and approved '
    };

    await expect(service.approveManualReplyNumberOrder(
      'customer-admin', input
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.approveManualReplyNumberOrder(
      '11111111-1111-4111-8111-111111111111', input
    )).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    expect(approveManualOrder).not.toHaveBeenCalled();

    await expect(service.approveManualReplyNumberOrder(
      '11111111-1111-4111-8111-111111111111',
      { ...input, approvalConfirmed: true }
    )).resolves.toEqual({ ok: true, value: {} });
    expect(approveManualOrder).toHaveBeenCalledWith({
      actorUserId: '11111111-1111-4111-8111-111111111111',
      organisationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 4,
      confirmedSetupFeeMinor: 1_135,
      confirmedMonthlyFeeMinor: 1_530,
      reason: 'Written costs reviewed and approved',
      now: new Date('2026-11-12T00:00:00.000Z')
    });
  });

  it('bounds manual provisioning references and rejects cross-record identifiers before persistence', async () => {
    const recordManualOrderReference = vi.fn();
    const recordFulfilledNumber = vi.fn();
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
      repository: {} as never,
      provisioningRepository: {
        recordManualOrderReference,
        recordFulfilledNumber
      } as never
    });

    await expect(service.recordManualReplyNumberOrder('owner-user', {
      organisationId: 'not-an-id',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 4,
      externalOrderReference: 'safe-reference',
      reason: 'Order placed outside AccountPulse'
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    await expect(service.recordManualReplyNumberOrder('owner-user', {
      organisationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 4,
      externalOrderReference: `unsafe\n${'x'.repeat(256)}`,
      reason: 'Order placed outside AccountPulse'
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    await expect(service.recordFulfilledReplyNumber('owner-user', {
      organisationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 5,
      e164Number: '0400000000',
      providerNumberId: 'sinch-number-safe',
      reason: 'Number supplied by provider'
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });

    expect(recordManualOrderReference).not.toHaveBeenCalled();
    expect(recordFulfilledNumber).not.toHaveBeenCalled();
  });

  it('rejects non-opaque or overlong documentation references before persistence', async () => {
    const recordQuote = vi.fn();
    const recordDocumentationComplete = vi.fn();
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
      repository: {} as never,
      provisioningRepository: {
        recordQuote,
        recordDocumentationComplete
      } as never,
      clock: { now: () => new Date('2026-11-12T00:00:00.000Z') }
    });
    const target = {
      organisationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 2,
      reason: 'Written evidence reviewed'
    };

    await expect(service.recordReplyNumberQuote('owner-user', {
      ...target,
      setupFeeMinor: 1_135,
      monthlyFeeMinor: 1_530,
      quoteExpiresAt: new Date('2026-11-30T00:00:00.000Z'),
      documentationStatus: 'REQUIRED',
      documentationEvidenceReference: 'case/reference with spaces'
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    await expect(service.completeReplyNumberDocumentation('owner-user', {
      ...target,
      documentationEvidenceReference: `A${'x'.repeat(128)}`
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });

    expect(recordQuote).not.toHaveBeenCalled();
    expect(recordDocumentationComplete).not.toHaveBeenCalled();
  });

  it('accepts only a bounded opaque external order reference', async () => {
    const recordManualOrderReference = vi
      .fn()
      .mockResolvedValue({ ok: true, value: {} });
    const service = createPlatformAdminService({
      verifyOwner: () => Promise.resolve(true),
      repository: {} as never,
      provisioningRepository: { recordManualOrderReference } as never,
      clock: { now: () => new Date('2026-11-12T00:00:00.000Z') }
    });
    const target = {
      organisationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      expectedVersion: 4,
      reason: 'Order placed outside AccountPulse'
    };

    await expect(service.recordManualReplyNumberOrder('owner-user', {
      ...target,
      externalOrderReference: 'order reference 123'
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    await expect(service.recordManualReplyNumberOrder('owner-user', {
      ...target,
      externalOrderReference: ' order.ref-123_AU '
    })).resolves.toEqual({ ok: true, value: {} });

    expect(recordManualOrderReference).toHaveBeenCalledWith({
      ...target,
      actorUserId: 'owner-user',
      externalOrderReference: 'order.ref-123_AU',
      now: new Date('2026-11-12T00:00:00.000Z')
    });
  });
});
