import { describe, expect, it, vi } from 'vitest';

import { createRetentionOperationsService } from './retention-operations.js';

const organisationId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-18T00:00:00.000Z');

describe('retention owner operations', () => {
  it('verifies the owner and applies an exact tenant filter to the retention queue', async () => {
    const page = { retentionCases: [], dataRequests: [] };
    const listOperations = vi.fn().mockResolvedValue(page);
    const service = createRetentionOperationsService({
      verifyOwner: (actorUserId) =>
        Promise.resolve(actorUserId === 'verified-owner'),
      repository: { listOperations } as never,
      clock: { now: () => now }
    });

    await expect(
      service.listOperations('verified-owner', {
        organisationId: ` ${organisationId} `
      })
    ).resolves.toEqual(page);
    expect(listOperations).toHaveBeenCalledWith({ organisationId });
  });

  it('records a verified request with an exact 14-day target after owner verification', async () => {
    const recordVerifiedRequest = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: requestId }
    });
    const service = createRetentionOperationsService({
      verifyOwner: (actorUserId) =>
        Promise.resolve(actorUserId === 'verified-owner'),
      repository: { recordVerifiedRequest } as never,
      clock: { now: () => now }
    });

    await expect(
      service.recordVerifiedRequest('verified-owner', {
        organisationId,
        requestType: 'DELETION',
        verificationReference: 'privacy-case-123',
        idempotencyKey: 'verified-request-123',
        verifiedAt: new Date('2026-09-17T09:30:00.000Z')
      })
    ).resolves.toEqual({ ok: true, value: { id: requestId } });

    expect(recordVerifiedRequest).toHaveBeenCalledWith({
      actorUserId: 'verified-owner',
      organisationId,
      requestType: 'DELETION',
      verificationReference: 'privacy-case-123',
      idempotencyKey: 'verified-request-123',
      verifiedAt: new Date('2026-09-17T09:30:00.000Z'),
      targetAt: new Date('2026-10-01T09:30:00.000Z'),
      now
    });
  });

  it('rejects an unauthorised or malformed owner operation before repository access', async () => {
    const recordVerifiedRequest = vi.fn();
    const reviewDataRequest = vi.fn();
    const service = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(false),
      repository: { recordVerifiedRequest, reviewDataRequest } as never,
      clock: { now: () => now }
    });

    await expect(
      service.reviewDataRequest('customer-admin', {
        organisationId,
        requestId,
        expectedVersion: 0,
        operationId: 'review-request-v0',
        reason: 'Review verified privacy request'
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reviewDataRequest).not.toHaveBeenCalled();

    const ownerService = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(true),
      repository: { recordVerifiedRequest, reviewDataRequest } as never,
      clock: { now: () => now }
    });
    await expect(
      ownerService.recordVerifiedRequest('verified-owner', {
        organisationId,
        requestType: 'DELETION',
        verificationReference: 'contains spaces and personal details',
        idempotencyKey: 'verified-request-123',
        verifiedAt: new Date('2026-09-17T09:30:00.000Z')
      })
    ).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    expect(recordVerifiedRequest).not.toHaveBeenCalled();
  });

  it('records opaque backup-ageing evidence with an expected-state guard', async () => {
    const recordBackupExpiryVerification = vi.fn().mockResolvedValue({
      ok: true,
      value: { organisationId }
    });
    const service = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(true),
      repository: { recordBackupExpiryVerification } as never,
      clock: { now: () => now }
    });

    await service.recordBackupExpiryVerification('verified-owner', {
      organisationId,
      closureEpisodeId: '33333333-3333-4333-8333-333333333333',
      verifiedAt: new Date('2026-09-17T05:00:00.000Z'),
      evidenceReference: 'ovh-backup-review-123',
      expectedUpdatedAt: new Date('2026-09-16T00:00:00.000Z'),
      operationId: 'verify-backup-33333333-v2',
      reason: 'Verified approved backup tiers have aged out'
    });

    expect(recordBackupExpiryVerification).toHaveBeenCalledWith({
      actorUserId: 'verified-owner',
      organisationId,
      closureEpisodeId: '33333333-3333-4333-8333-333333333333',
      verifiedAt: new Date('2026-09-17T05:00:00.000Z'),
      evidenceReference: 'ovh-backup-review-123',
      expectedUpdatedAt: new Date('2026-09-16T00:00:00.000Z'),
      operationId: 'verify-backup-33333333-v2',
      reason: 'Verified approved backup tiers have aged out',
      now
    });
  });

  it('completes a request-bound export with explicit retry identity', async () => {
    const completeExportRequest = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: requestId, status: 'COMPLETED' }
    });
    const service = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(true),
      repository: { completeExportRequest } as never,
      clock: { now: () => now }
    });

    await expect(
      service.completeExportRequest('verified-owner', {
        organisationId,
        requestId,
        expectedVersion: 2,
        operationId: 'complete-export-request-v2',
        deliveryReference: 'secure-delivery-123'
      })
    ).resolves.toEqual({
      ok: true,
      value: { id: requestId, status: 'COMPLETED' }
    });
    expect(completeExportRequest).toHaveBeenCalledWith({
      actorUserId: 'verified-owner',
      organisationId,
      requestId,
      expectedVersion: 2,
      operationId: 'complete-export-request-v2',
      deliveryReference: 'secure-delivery-123',
      now
    });
  });
});
