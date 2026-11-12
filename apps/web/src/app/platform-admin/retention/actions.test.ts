import { describe, expect, it, vi } from 'vitest';

import { createRetentionActionHandlers } from './actions.js';

const session = {
  userId: 'verified-owner',
  cognitoSubject: 'owner-subject',
  email: 'owner@example.invalid',
  displayName: 'Verified Owner',
  memberships: [],
  expiresAt: '2026-09-18T00:00:00.000Z'
};

describe('retention owner actions', () => {
  it('uses the verified owner identity and parses verified-request input', async () => {
    const recordVerifiedRequest = vi.fn().mockResolvedValue({ ok: true });
    const revalidate = vi.fn();
    const redirect = vi.fn();
    const actions = createRetentionActionHandlers({
      getOwnerSession: () => Promise.resolve(session),
      service: { recordVerifiedRequest } as never,
      revalidate,
      redirect
    });
    const formData = new FormData();
    formData.set('organisationId', '11111111-1111-4111-8111-111111111111');
    formData.set('requestType', 'DELETION');
    formData.set('verificationReference', 'privacy-case-123');
    formData.set('idempotencyKey', 'verified-request-123');
    formData.set('verifiedAt', '2026-09-17T09:30');
    formData.set('actorUserId', 'forged-owner');

    await actions.recordVerifiedRequest(formData);

    expect(recordVerifiedRequest).toHaveBeenCalledWith('verified-owner', {
      organisationId: '11111111-1111-4111-8111-111111111111',
      requestType: 'DELETION',
      verificationReference: 'privacy-case-123',
      idempotencyKey: 'verified-request-123',
      verifiedAt: new Date('2026-09-17T09:30:00.000Z')
    });
    expect(revalidate).toHaveBeenCalledWith('/platform-admin/retention');
    expect(redirect).toHaveBeenCalledWith(
      '/platform-admin/retention?result=UPDATED'
    );
  });

  it('passes tenant and version guards to the owner review workflow', async () => {
    const reviewDataRequest = vi.fn().mockResolvedValue({
      ok: false,
      code: 'CONFLICT'
    });
    const redirect = vi.fn();
    const actions = createRetentionActionHandlers({
      getOwnerSession: () => Promise.resolve(session),
      service: { reviewDataRequest } as never,
      revalidate: vi.fn(),
      redirect
    });
    const formData = new FormData();
    formData.set('organisationId', '11111111-1111-4111-8111-111111111111');
    formData.set('requestId', '22222222-2222-4222-8222-222222222222');
    formData.set('expectedVersion', '3');
    formData.set('operationId', 'review-request-22222222-v3');
    formData.set('reason', 'Re-check legal and backup safeguards');

    await actions.reviewRequest(formData);

    expect(reviewDataRequest).toHaveBeenCalledWith('verified-owner', {
      organisationId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222',
      expectedVersion: 3,
      operationId: 'review-request-22222222-v3',
      reason: 'Re-check legal and backup safeguards'
    });
    expect(redirect).toHaveBeenCalledWith(
      '/platform-admin/retention?result=CONFLICT'
    );
  });

  it('parses backup-ageing evidence for the verified owner', async () => {
    const recordBackupExpiryVerification = vi
      .fn()
      .mockResolvedValue({ ok: true });
    const actions = createRetentionActionHandlers({
      getOwnerSession: () => Promise.resolve(session),
      service: { recordBackupExpiryVerification } as never,
      revalidate: vi.fn(),
      redirect: vi.fn()
    });
    const formData = new FormData();
    formData.set('organisationId', '11111111-1111-4111-8111-111111111111');
    formData.set('closureEpisodeId', '33333333-3333-4333-8333-333333333333');
    formData.set('verifiedAt', '2026-09-17T05:00');
    formData.set('evidenceReference', 'ovh-backup-review-123');
    formData.set('expectedUpdatedAt', '2026-09-16T00:00:00.000Z');
    formData.set('operationId', 'backup-episode-33333333-v2');
    formData.set('reason', 'Verified approved backup tiers have aged out');

    await actions.recordBackupExpiryVerification(formData);

    expect(recordBackupExpiryVerification).toHaveBeenCalledWith(
      'verified-owner',
      {
        organisationId: '11111111-1111-4111-8111-111111111111',
        closureEpisodeId: '33333333-3333-4333-8333-333333333333',
        verifiedAt: new Date('2026-09-17T05:00:00.000Z'),
        evidenceReference: 'ovh-backup-review-123',
        expectedUpdatedAt: new Date('2026-09-16T00:00:00.000Z'),
        operationId: 'backup-episode-33333333-v2',
        reason: 'Verified approved backup tiers have aged out'
      }
    );
  });

  it('completes a request-bound export for the verified owner', async () => {
    const completeExportRequest = vi.fn().mockResolvedValue({ ok: true });
    const actions = createRetentionActionHandlers({
      getOwnerSession: () => Promise.resolve(session),
      service: { completeExportRequest } as never,
      revalidate: vi.fn(),
      redirect: vi.fn()
    });
    const formData = new FormData();
    formData.set('organisationId', '11111111-1111-4111-8111-111111111111');
    formData.set('requestId', '22222222-2222-4222-8222-222222222222');
    formData.set('expectedVersion', '4');
    formData.set('operationId', 'complete-export-22222222-v4');
    formData.set('deliveryReference', 'secure-delivery-123');

    await actions.completeExportRequest(formData);

    expect(completeExportRequest).toHaveBeenCalledWith('verified-owner', {
      organisationId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222',
      expectedVersion: 4,
      operationId: 'complete-export-22222222-v4',
      deliveryReference: 'secure-delivery-123'
    });
  });
});
