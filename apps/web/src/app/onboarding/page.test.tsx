import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const requireWebAcceptedIdentitySession = vi.hoisted(() => vi.fn());
const getStatus = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers())
}));

vi.mock('../../server/runtime.js', () => ({
  requireWebAcceptedIdentitySession,
  getOnboardingService: () => ({ getStatus })
}));

import SelfServiceOnboardingPage from './page.js';

describe('self-service onboarding entry', () => {
  it('offers Xero connection to a verified provisional identity', async () => {
    requireWebAcceptedIdentitySession.mockResolvedValueOnce({
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
    requireWebAcceptedIdentitySession.mockResolvedValueOnce({
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

  it('guides an owner-created customer to connect Xero without claiming it is connected', async () => {
    requireWebAcceptedIdentitySession.mockResolvedValueOnce({
      userId: 'user_invited',
      cognitoSubject: 'subject_invited',
      displayName: 'Invited Administrator',
      expiresAt: '2026-11-11T00:00:00.000Z',
      memberships: [
        { organisationId: 'org_invited', role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }
      ]
    });
    getStatus.mockResolvedValueOnce({
      completedCount: 0,
      complete: false,
      steps: [
        {
          key: 'XERO_CONNECTED',
          label: 'Connect Xero',
          description: 'Connect Xero',
          href: '/settings/integrations',
          complete: false
        }
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

    expect(markup).toContain('Complete your AccountPulse setup');
    expect(markup).toContain('Connect Xero to begin');
    expect(markup).toContain('organisationId=org_invited');
    expect(markup).not.toContain('Your Xero organisation is connected');
  });

  it('asks an unpaid customer to activate without promising a trial', async () => {
    requireWebAcceptedIdentitySession.mockResolvedValueOnce({
      userId: 'user_unpaid',
      cognitoSubject: 'subject_unpaid',
      displayName: 'Unpaid Administrator',
      expiresAt: '2026-11-11T00:00:00.000Z',
      memberships: [
        { organisationId: 'org_unpaid', role: 'ADMIN', active: true, organisationStatus: 'ACTIVE' }
      ]
    });
    getStatus.mockResolvedValueOnce({
      completedCount: 1,
      complete: false,
      steps: [],
      trial: {
        readOnly: true,
        canSync: false,
        canPreview: false,
        testSmsPartLimit: 0,
        testSmsDestination: null,
        canSendCustomers: false,
        canEnableAutomatic: false,
        canAssignPermanentNumber: false,
        actions: ['SUBSCRIBE', 'EXPORT', 'DISCONNECT']
      }
    });

    const markup = renderToStaticMarkup(
      await SelfServiceOnboardingPage({ searchParams: Promise.resolve({}) })
    );

    expect(markup).toContain('Payment is required to activate AccountPulse');
    expect(markup).not.toContain('Your trial is read-only');
  });
});
