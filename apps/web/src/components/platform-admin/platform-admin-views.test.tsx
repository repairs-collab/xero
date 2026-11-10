import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PlatformAuditList } from './audit-list.js';
import { PlatformOrganisationDetailView } from './organisation-detail.js';
import { PlatformAdminOverview } from './overview.js';
import { PlatformSmsAdministration } from './sms-administration.js';

const noAction = (): Promise<void> => Promise.resolve();
const now = new Date('2026-11-11T00:00:00.000Z');

const organisation = {
  id: 'organisation-1',
  xeroOrganisationId: 'xero-organisation-1',
  name: 'Alpha Repairs',
  edition: 'SOLO' as const,
  timeZone: 'Australia/Sydney',
  baseCurrency: 'AUD',
  platformStatus: 'ACTIVE' as const,
  platformStatusVersion: 3,
  suspendedAt: null,
  suspensionReason: null,
  lastSuccessfulSyncAt: now,
  subscription: {
    status: 'TRIALING' as const,
    planCode: 'SOLO_AU_2000',
    trialEndsAt: new Date('2026-11-25T00:00:00.000Z'),
    currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
    updatedAt: now,
    lastStripeEventCreatedAt: now
  },
  xero: {
    tenantId: 'xero-tenant-alpha',
    status: 'CONNECTED' as const,
    connectedAt: now,
    lastRefreshedAt: now
  },
  smsNumber: {
    id: 'number-1',
    e164Number: '+61400000001',
    provider: 'SINCH',
    providerNumberId: 'sinch-number-1',
    status: 'READY' as const,
    organisationId: 'organisation-1',
    organisationName: 'Alpha Repairs',
    reservedAt: now,
    readyAt: now,
    releasedAt: null,
    quarantineUntil: null,
    createdAt: now,
    updatedAt: now
  },
  smsUsage: {
    billingPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
    billingPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
    includedParts: 2_000,
    warningPercent: 80,
    committedParts: 450,
    reservedParts: 10
  },
  userSearchTerms: ['owner@alpha.example']
};

describe('platform owner views', () => {
  it('renders KPI counts plus searchable and sortable customer columns', () => {
    const suspended = {
      ...organisation,
      id: 'organisation-2',
      name: 'Beta Services',
      platformStatus: 'SUSPENDED' as const,
      subscription: { ...organisation.subscription, status: 'ACTIVE' as const }
    };
    const html = renderToStaticMarkup(
      <PlatformAdminOverview
        page={{ items: [organisation, suspended], total: 2, page: 1, pageSize: 25 }}
        filters={{ search: 'Alpha', sort: 'usage', direction: 'desc' }}
      />
    );

    expect(html).toContain('2 customers');
    expect(html).toContain('1 suspended');
    expect(html).toContain('1 trialing');
    expect(html).toContain('Search customers');
    expect(html).toContain('Sort customers');
    expect(html).toContain('Trial / subscription');
    expect(html).toContain('Xero');
    expect(html).toContain('SMS usage');
    expect(html).toContain('Last sync');
    expect(html).toContain('Alpha Repairs');
  });

  it('renders customer facts and reasoned confirmation controls without secrets', () => {
    const html = renderToStaticMarkup(
      <PlatformOrganisationDetailView
        detail={{
          ...organisation,
          users: [{
            id: 'user-1',
            email: 'owner@alpha.example',
            displayName: 'Alpha Owner',
            role: 'ADMIN',
            userDisabledAt: null,
            membershipDisabledAt: null
          }],
          invitations: [],
          onboarding: {
            version: 1,
            completedVersion: 1,
            completedAt: now,
            xeroConnectedAt: now,
            syncReconciledAt: now,
            adminMobileVerifiedAt: now,
            testSmsCompletedAt: now,
            sequenceReviewedAt: now,
            subscriptionReadyAt: now,
            replyNumberReadyAt: now
          }
        }}
        actions={{
          extendTrial: noAction,
          endTrial: noAction,
          suspend: noAction,
          reactivate: noAction,
          updateAllowance: noAction,
          inviteUser: noAction,
          resendInvitation: noAction,
          changeRole: noAction,
          disableUser: noAction
        }}
        feedbackCode="CONFLICT"
      />
    );

    expect(html).toContain('The record changed');
    expect(html).toContain('xero-tenant-alpha');
    expect(html).toContain('+61400000001');
    expect(html).toContain('460 of 2,000 parts');
    expect(html).toContain('name="reason"');
    expect(html).toContain('name="confirmation"');
    expect(html).toContain('name="expectedVersion" value="3"');
    expect(html).toContain('name="expectedUpdatedAt"');
    expect(html).not.toContain('secretArn');
    expect(html).not.toContain('encryptedRefreshToken');
    expect(html).not.toContain('ciphertext');
  });

  it('renders Sinch number lifecycle and assignment controls', () => {
    const html = renderToStaticMarkup(
      <PlatformSmsAdministration
        page={{ items: [organisation.smsNumber], total: 1, page: 1, pageSize: 25 }}
        organisations={[{ id: organisation.id, name: organisation.name }]}
        filters={{ search: '', status: '' }}
        actions={{
          register: noAction,
          assign: noAction,
          ready: noAction,
          quarantine: noAction,
          release: noAction,
          returnToPool: noAction
        }}
      />
    );

    expect(html).toContain('Register Sinch number');
    expect(html).toContain('sinch-number-1');
    expect(html).toContain('Ready');
    expect(html).toContain('Assign customer');
    expect(html).toContain('Cooling until');
    expect(html).toContain('name="reason"');
  });

  it('renders filterable audit summaries while redacting sensitive and message fields', () => {
    const html = renderToStaticMarkup(
      <PlatformAuditList
        page={{
          items: [{
            id: 'audit-1',
            actorUserId: 'owner-user',
            actorEmail: 'repairs@motts.com.au',
            actorDisplayName: 'AccountPulse Owner',
            targetOrganisationId: organisation.id,
            organisationName: organisation.name,
            eventType: 'SMS_NUMBER_READY',
            entityType: 'SMS_NUMBER',
            entityId: 'number-1',
            reason: 'Verified in Sinch',
            beforeValue: { status: 'RESERVED', ciphertext: 'never-render' },
            afterValue: { status: 'READY', messageBody: 'never-render-either' },
            correlationId: 'correlation-1',
            occurredAt: now
          }],
          total: 1,
          page: 1,
          pageSize: 25
        }}
        filters={{ organisationId: '', actorUserId: '', eventType: '' }}
      />
    );

    expect(html).toContain('Filter audit history');
    expect(html).toContain('Verified in Sinch');
    expect(html).toContain('Status: RESERVED → READY');
    expect(html).not.toContain('never-render');
    expect(html).not.toContain('{&quot;status&quot;');
  });
});
