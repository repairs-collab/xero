import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PlatformRetentionOperations } from './retention-operations.js';

const noAction = (): Promise<void> => Promise.resolve();

describe('platform retention operations view', () => {
  it('renders five-year eligibility and verified-request targets as a non-destructive owner workflow', () => {
    const html = renderToStaticMarkup(
      <PlatformRetentionOperations
        page={{
          retentionCases: [
            {
              organisationId: '11111111-1111-4111-8111-111111111111',
              organisationName: 'Alpha Repairs',
              source: 'SUBSCRIPTION_CANCELLED',
              status: 'LEGAL_HOLD',
              reviewAfter: new Date('2026-10-01T00:00:00.000Z'),
              deletionEligibleAt: new Date('2031-09-01T00:00:00.000Z'),
              closureEpisodeId: '33333333-3333-4333-8333-333333333333',
              closureVersion: 2,
              backupExpiryVerifiedAt: null,
              backupExpiryEvidenceReference: null,
              updatedAt: new Date('2026-09-18T00:00:00.000Z')
            }
          ],
          dataRequests: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              organisationId: '11111111-1111-4111-8111-111111111111',
              organisationName: 'Alpha Repairs',
              requestType: 'EXPORT',
              status: 'IN_REVIEW',
              verificationReference: 'privacy-case-123',
              verifiedAt: new Date('2026-09-17T09:30:00.000Z'),
              targetAt: new Date('2026-10-01T09:30:00.000Z'),
              version: 1,
              blockReason: null,
              retentionClosureEpisodeId: '33333333-3333-4333-8333-333333333333',
              lastReviewedAt: new Date('2026-09-18T00:00:00.000Z'),
              completedAt: null,
              completionReference: null,
              updatedAt: new Date('2026-09-18T00:00:00.000Z')
            }
          ]
        }}
        organisationId=""
        feedbackCode="UPDATED"
        actions={{
          recordVerifiedRequest: noAction,
          reviewRequest: noAction,
          recordBackupExpiryVerification: noAction,
          completeExportRequest: noAction
        }}
      />
    );

    expect(html).toContain('Retention &amp; privacy requests');
    expect(html).toContain('Five-year deletion eligibility');
    expect(html).toContain('1 Sept 2031');
    expect(html).toContain('14-day target');
    expect(html).toContain('1 Oct 2026');
    expect(html).toContain('Legal hold');
    expect(html).toContain('No automatic deletion');
    expect(html).toContain('privacy-case-123');
    expect(html).toContain('name="expectedVersion" value="1"');
    expect(html).toContain('name="operationId" value="review-22222222-2222-4222-8222-222222222222-v1"');
    expect(html).toContain('Record verified request');
    expect(html).toContain('Record backup-ageing evidence');
    expect(html).toContain('name="closureEpisodeId" value="33333333-3333-4333-8333-333333333333"');
    expect(html).toContain('name="operationId" value="backup-33333333-3333-4333-8333-333333333333-at1789689600000"');
    expect(html).toContain(
      'name="expectedUpdatedAt" value="2026-09-18T00:00:00.000Z"'
    );
    expect(html).toContain(
      '/platform-admin/organisations/11111111-1111-4111-8111-111111111111/backup?requestId=22222222-2222-4222-8222-222222222222'
    );
    expect(html).toContain('Mark export delivered');
    expect(html).toContain('name="deliveryReference"');
    expect(html).not.toContain('Delete customer now');
    expect(html).not.toContain('idempotencyKey</');
  });

  it('uses retention updated state for a fresh backup-verification operation while exact rerenders stay stable', () => {
    const render = (updatedAt: Date): string =>
      renderToStaticMarkup(
        <PlatformRetentionOperations
          page={{
            retentionCases: [
              {
                organisationId: '11111111-1111-4111-8111-111111111111',
                organisationName: 'Alpha Repairs',
                source: 'SUBSCRIPTION_CANCELLED',
                status: 'REVIEW_REQUIRED',
                reviewAfter: new Date('2026-10-01T00:00:00.000Z'),
                deletionEligibleAt: new Date('2031-09-01T00:00:00.000Z'),
                closureEpisodeId: '33333333-3333-4333-8333-333333333333',
                closureVersion: 2,
                backupExpiryVerifiedAt: null,
                backupExpiryEvidenceReference: null,
                updatedAt
              }
            ],
            dataRequests: []
          }}
          organisationId=""
          actions={{
            recordVerifiedRequest: noAction,
            reviewRequest: noAction,
            recordBackupExpiryVerification: noAction,
            completeExportRequest: noAction
          }}
        />
      );

    const first = render(new Date('2026-09-18T00:00:00.000Z'));
    const exactRetry = render(new Date('2026-09-18T00:00:00.000Z'));
    const refreshed = render(new Date('2026-09-19T00:00:00.000Z'));

    expect(first).toContain(
      'name="operationId" value="backup-33333333-3333-4333-8333-333333333333-at1789689600000"'
    );
    expect(exactRetry).toContain(
      'name="operationId" value="backup-33333333-3333-4333-8333-333333333333-at1789689600000"'
    );
    expect(refreshed).toContain(
      'name="operationId" value="backup-33333333-3333-4333-8333-333333333333-at1789776000000"'
    );
  });
});
