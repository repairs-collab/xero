import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PlatformAuditList } from './audit-list.js';
import { PlatformBillingOperations } from './billing-operations.js';
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
    providerVerifiedAt: now,
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
    reservedParts: 10,
    allowanceUpdatedAt: now
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
        page={{ items: [organisation, suspended], total: 60, page: 1, pageSize: 25, metrics: { active: 54, suspended: 6, trialing: 12 } }}
        filters={{ search: 'Alpha', sort: 'usage', direction: 'desc' }}
      />
    );

    expect(html).toContain('60 customers');
    expect(html).toContain('6 suspended');
    expect(html).toContain('12 trialing');
    expect(html).toContain('Search customers');
    expect(html).toContain('Sort customers');
    expect(html).toContain('Trial / subscription');
    expect(html).toContain('Xero');
    expect(html).toContain('SMS usage');
    expect(html).toContain('Last sync');
    expect(html).toContain('Alpha Repairs');
    expect(html).toContain('Next →');
    expect(html).toContain('Page 1 of 3');
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
            membershipVersion: 0,
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

  it('renders actionable feedback when unresolved financial risk blocks reactivation', () => {
    const html = renderToStaticMarkup(
      <PlatformOrganisationDetailView
        detail={{
          ...organisation,
          platformStatus: 'SUSPENDED',
          suspendedAt: now,
          suspensionReason: 'Stripe payment failure',
          users: [],
          invitations: [],
          onboarding: null
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
        feedbackCode="BILLING_RISK_HOLD"
      />
    );

    expect(html).toContain('Financial review required');
    expect(html).toContain(
      'resolve the open payment or dispute case before reactivating this account.'
    );
  });

  it('renders a redacted read-only billing queue with independent continuation links', () => {
    const html = renderToStaticMarkup(
      <PlatformBillingOperations
        page={{
          cases: {
            items: [{
              id: 'case-1',
              organisationId: organisation.id,
              organisationName: organisation.name,
              kind: 'DISPUTE',
              status: 'OPEN',
              providerObjectType: 'DISPUTE',
              providerReference: 'dp_safe_reference',
              providerStatus: 'needs_response',
              subscriptionRelation: 'CURRENT',
              amountMinor: 12_345,
              currency: 'aud',
              blocksSending: true,
              openedAt: now,
              resolvedAt: null,
              createdAt: now
            }],
            nextCursor: 'next-cases'
          },
          heldEmails: {
            items: [{
              id: 'email-1',
              organisationId: organisation.id,
              organisationName: organisation.name,
              billingCaseId: 'case-1',
              recipient: 'billing@alpha.example',
              template: 'DISPUTE_OPENED',
              status: 'HELD',
              createdAt: now
            }],
            nextCursor: 'next-emails'
          }
        }}
        filters={{
          organisationId: organisation.id,
          caseKind: 'DISPUTE',
          caseStatus: 'OPEN',
          casesCursor: '',
          heldEmailsCursor: ''
        }}
      />
    );

    expect(html).toContain('Billing operations');
    expect(html).toContain('Held — not delivered');
    expect(html).toContain('Alpha Repairs');
    expect(html).toContain('dp_safe_reference');
    expect(html).toContain('$123.45');
    expect(html).toContain('billing@alpha.example');
    expect(html).toContain('casesCursor=next-cases');
    expect(html).toContain('heldEmailsCursor=next-emails');
    expect(html).not.toContain('renderData');
    expect(html).not.toContain('idempotencyKey');
    expect(html).not.toContain('latestProviderEventId');
    expect(html).not.toContain('Send now');
    expect(html).not.toContain('Resolve case');
    expect(html).not.toContain('Release notice');
  });

  it('renders Sinch number lifecycle and assignment controls', () => {
    const availableNumber = {
      ...organisation.smsNumber,
      id: 'number-2',
      e164Number: '+61400000002',
      providerNumberId: null,
      providerVerifiedAt: null,
      status: 'AVAILABLE' as const,
      organisationId: null,
      organisationName: null,
      reservedAt: null,
      readyAt: null
    };
    const html = renderToStaticMarkup(
      <PlatformSmsAdministration
        page={{ items: [organisation.smsNumber, availableNumber], total: 30, page: 1, pageSize: 25 }}
        organisations={[{ id: organisation.id, name: organisation.name }]}
        filters={{ search: '', customerSearch: 'Alpha', status: '' }}
        feedbackCode="UPDATED"
        actions={{
          register: noAction,
          verify: noAction,
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
    expect(html).toContain('Verify for automatic allocation');
    expect(html).toContain('name="verificationConfirmed"');
    expect(html).toContain('Only verified pool numbers can be assigned automatically');
    expect(html).toContain('Verified for automatic allocation');
    expect(html).toContain('name="reason"');
    expect(html).toContain('Find customer');
    expect(html).toContain('Change saved');
    expect(html).toContain('Next →');
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
          total: 60,
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
    expect(html).toContain('Page 1 of 3');
    expect(html).toContain('Next →');
  });
});
