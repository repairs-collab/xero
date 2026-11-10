import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const requireWebIdentitySession = vi.hoisted(() => vi.fn());
const getStatus = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers())
}));

vi.mock('../../server/runtime.js', () => ({
  requireWebIdentitySession,
  getOnboardingService: () => ({ getStatus })
}));

import SelfServiceOnboardingPage from './page.js';

describe('self-service onboarding entry', () => {
  it('offers Xero connection to a verified provisional identity', async () => {
    requireWebIdentitySession.mockResolvedValueOnce({
      userId: 'user_new',
      cognitoSubject: 'subject_new',
      displayName: 'New Owner',
      expiresAt: '2026-11-11T00:00:00.000Z',
      memberships: []
    });

    const markup = renderToStaticMarkup(
      await SelfServiceOnboardingPage({ searchParams: Promise.resolve({}) })
    );

    expect(markup).toContain('Connect your Xero organisation');
    expect(markup).toContain('href="/xero/connect?purpose=solo"');
    expect(markup).toContain('dry-run review mode');
  });

  it('shows the existing Solo workspace and Enterprise waitlist instead of another connection', async () => {
    requireWebIdentitySession.mockResolvedValueOnce({
      userId: 'user_existing',
      cognitoSubject: 'subject_existing',
      displayName: 'Existing Owner',
      expiresAt: '2026-11-11T00:00:00.000Z',
      memberships: [
        { organisationId: 'org_existing', role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }
      ]
    });
    getStatus.mockResolvedValueOnce({
      completedCount: 2,
      complete: false,
      steps: [
        {
          key: 'XERO_CONNECTED',
          label: 'Connect Xero',
          description: 'Connected',
          href: '/settings/integrations',
          complete: true
        },
        {
          key: 'SYNC_RECONCILED',
          label: 'Reconcile the first sync',
          description: 'Reconciled',
          href: '/settings/sending',
          complete: true
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          key: `INCOMPLETE_${index}`,
          label: `Incomplete step ${index + 1}`,
          description: 'Action required',
          href: '/onboarding',
          complete: false
        }))
      ],
      trial: {
        readOnly: false,
        canSync: true,
        canPreview: true,
        testSmsPartLimit: 10,
        testSmsDestination: null,
        canSendCustomers: false,
        canEnableAutomatic: false,
        canAssignPermanentNumber: false,
        actions: []
      }
    });

    const markup = renderToStaticMarkup(
      await SelfServiceOnboardingPage({ searchParams: Promise.resolve({}) })
    );

    expect(markup).toContain('Your Xero organisation is connected');
    expect(markup).toContain('Onboarding progress');
    expect(markup).toContain('2 of 8 complete');
    expect(markup).toContain('Enterprise waitlist');
    expect(markup).not.toContain('href="/xero/connect?purpose=solo"');
  });
});
