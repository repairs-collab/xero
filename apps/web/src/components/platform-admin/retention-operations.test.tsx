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
              requestType: 'DELETION',
              status: 'BLOCKED',
              verificationReference: 'privacy-case-123',
              verifiedAt: new Date('2026-09-17T09:30:00.000Z'),
              targetAt: new Date('2026-10-01T09:30:00.000Z'),
              version: 1,
              blockReason: 'LEGAL_HOLD',
              lastReviewedAt: new Date('2026-09-18T00:00:00.000Z'),
              updatedAt: new Date('2026-09-18T00:00:00.000Z')
            }
          ]
        }}
        organisationId=""
        feedbackCode="UPDATED"
        actions={{
          recordVerifiedRequest: noAction,
          reviewRequest: noAction,
          recordBackupExpiryVerification: noAction
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
    expect(html).toContain('Record verified request');
    expect(html).toContain('Record backup-ageing evidence');
    expect(html).toContain(
      'name="expectedUpdatedAt" value="2026-09-18T00:00:00.000Z"'
    );
    expect(html).not.toContain('Delete customer now');
    expect(html).not.toContain('idempotencyKey</');
  });
});
