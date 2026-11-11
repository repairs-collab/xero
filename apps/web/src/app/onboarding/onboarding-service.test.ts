import { describe, expect, it } from 'vitest';

import {
  createOnboardingService,
  deriveOnboardingStatus,
  deriveSoloTrialExperience,
  type OnboardingEvidence,
  type OnboardingRepository
} from './onboarding-service.js';

const now = new Date('2026-11-10T00:00:00.000Z');

const evidence = (
  overrides: Partial<OnboardingEvidence> = {}
): OnboardingEvidence => ({
  xeroConnectionStatus: 'CONNECTED',
  operationalState: 'RECONCILED',
  lastSuccessfulSyncAt: new Date('2026-11-09T23:55:00.000Z'),
  latestReconciledSyncAt: new Date('2026-11-09T23:55:00.000Z'),
  businessDetailsCompletedAt: now,
  adminMobile: '+61412345678',
  adminMobileVerifiedAt: now,
  acceptedTestSmsParts: 1,
  sequenceCount: 1,
  allSequencesInReview: true,
  sequenceReviewedAt: now,
  subscriptionStatus: 'ACTIVE',
  trialEndsAt: null,
  replyNumberStatus: 'READY',
  ...overrides
});
describe('AccountPulse Solo onboarding evidence', () => {
  it('returns the ordered eight-step checklist', () => {
    const status = deriveOnboardingStatus(evidence());

    expect(status.steps.map((step) => step.key)).toEqual([
      'XERO_CONNECTED',
      'SYNC_RECONCILED',
      'BUSINESS_DETAILS',
      'ADMIN_MOBILE_VERIFIED',
      'TEST_SMS_COMPLETED',
      'SEQUENCE_REVIEWED',
      'SUBSCRIPTION_ACTIVE',
      'REPLY_NUMBER_READY'
    ]);
    expect(status.steps.every((step) => step.complete)).toBe(true);
    expect(status).toMatchObject({ completedCount: 8, complete: true });
  });

  it('derives protected steps from operational evidence instead of timestamps alone', () => {
    const timestampOnly = evidence({
      xeroConnectionStatus: 'DISCONNECTED',
      operationalState: 'READY',
      latestReconciledSyncAt: null,
      adminMobile: '+61350324518',
      acceptedTestSmsParts: 0,
      subscriptionStatus: 'TRIALING',
      trialEndsAt: new Date('2026-11-24T00:00:00.000Z'),
      replyNumberStatus: null
    });

    const status = deriveOnboardingStatus(timestampOnly);
    const byKey = Object.fromEntries(
      status.steps.map((step) => [step.key, step.complete])
    );

    expect(byKey).toMatchObject({
      XERO_CONNECTED: false,
      SYNC_RECONCILED: false,
      ADMIN_MOBILE_VERIFIED: false,
      TEST_SMS_COMPLETED: false,
      SUBSCRIPTION_ACTIVE: false,
      REPLY_NUMBER_READY: false
    });
    expect(status.complete).toBe(false);
  });

  it.each([
    ['before', 'active', new Date(now.getTime() + 1), true],
    ['at', 'active', now, false],
    ['without verified provenance', null, new Date(now.getTime() + 1), false]
  ])('uses paid cancellation eligibility %s the boundary', (_label, stripeProviderStatus, currentPeriodEnd, paid) => {
    const input = evidence({ subscriptionStatus: 'CANCEL_AT_PERIOD_END', stripeProviderStatus, currentPeriodEnd, cancelAt: null });
    expect(deriveOnboardingStatus(input, now).steps.find((step) => step.key === 'SUBSCRIPTION_ACTIVE')?.complete).toBe(paid);
    expect(deriveSoloTrialExperience({ subscriptionStatus: input.subscriptionStatus, stripeProviderStatus: input.stripeProviderStatus ?? null, currentPeriodEnd: input.currentPeriodEnd ?? null, cancelAt: input.cancelAt ?? null, trialEndsAt: input.trialEndsAt, verifiedAdminMobile: input.adminMobile }, now).canAssignPermanentNumber).toBe(paid);
  });

  it('requires at least one reviewed sequence and keeps automatic mode out of onboarding', () => {
    expect(
      deriveOnboardingStatus(evidence({ sequenceCount: 0 })).steps.find(
        (step) => step.key === 'SEQUENCE_REVIEWED'
      )?.complete
    ).toBe(false);
    expect(
      deriveOnboardingStatus(
        evidence({ allSequencesInReview: false })
      ).steps.find((step) => step.key === 'SEQUENCE_REVIEWED')?.complete
    ).toBe(false);
  });
});

describe('guided onboarding actions', () => {
  const session = (role: 'ADMIN' | 'OPERATOR') => ({
    userId: `user_${role.toLowerCase()}`,
    cognitoSubject: `subject_${role.toLowerCase()}`,
    displayName: role,
    expiresAt: '2026-11-11T00:00:00.000Z',
    memberships: [
      {
        organisationId: 'org_solo',
        role,
        active: true as const,
        organisationStatus: 'ACTIVE' as const
      }
    ]
  });

  class FakeOnboardingRepository implements OnboardingRepository {
    current = evidence({
      businessDetailsCompletedAt: null,
      sequenceReviewedAt: null
    });
    attestations: Array<{
      organisationId: string;
      userId: string;
      kind: 'BUSINESS_DETAILS' | 'SEQUENCE_REVIEW';
      occurredAt: Date;
    }> = [];
    completions: Array<{
      organisationId: string;
      userId: string;
      version: number;
      occurredAt: Date;
    }> = [];

    load(): Promise<OnboardingEvidence> {
      return Promise.resolve(this.current);
    }

    recordAttestation(
      input: (typeof this.attestations)[number]
    ): Promise<void> {
      this.attestations.push(input);
      return Promise.resolve();
    }

    markCompleted(input: (typeof this.completions)[number]): Promise<void> {
      this.completions.push(input);
      return Promise.resolve();
    }
  }

  it('lets an Administrator attest only the human-reviewable steps', async () => {
    const repository = new FakeOnboardingRepository();
    const service = createOnboardingService({
      repository,
      clock: { now: () => now }
    });

    await service.confirmBusinessDetails(session('ADMIN'), 'org_solo');
    await service.confirmSequenceReview(session('ADMIN'), 'org_solo');

    expect(repository.attestations).toEqual([
      {
        organisationId: 'org_solo',
        userId: 'user_admin',
        kind: 'BUSINESS_DETAILS',
        occurredAt: now
      },
      {
        organisationId: 'org_solo',
        userId: 'user_admin',
        kind: 'SEQUENCE_REVIEW',
        occurredAt: now
      }
    ]);
    expect(Object.keys(service)).toEqual([
      'getStatus',
      'confirmBusinessDetails',
      'confirmSequenceReview'
    ]);
  });

  it('rejects Operator attestations and automatic sequence review', async () => {
    const repository = new FakeOnboardingRepository();
    const service = createOnboardingService({
      repository,
      clock: { now: () => now }
    });

    await expect(
      service.confirmBusinessDetails(session('OPERATOR'), 'org_solo')
    ).rejects.toThrow('FORBIDDEN');
    repository.current = evidence({
      sequenceReviewedAt: null,
      allSequencesInReview: false
    });
    await expect(
      service.confirmSequenceReview(session('ADMIN'), 'org_solo')
    ).rejects.toThrow('SEQUENCES_NOT_READY_FOR_REVIEW');
    expect(repository.attestations).toEqual([]);
  });

  it('records completion only after every evidence-backed step passes', async () => {
    const repository = new FakeOnboardingRepository();
    repository.current = evidence();
    const service = createOnboardingService({
      repository,
      clock: { now: () => now }
    });

    await expect(
      service.getStatus(session('ADMIN'), 'org_solo')
    ).resolves.toMatchObject({ complete: true });
    expect(repository.completions).toEqual([
      {
        organisationId: 'org_solo',
        userId: 'user_admin',
        version: 1,
        occurredAt: now
      }
    ]);

    repository.current = evidence({ replyNumberStatus: null });
    await expect(
      service.getStatus(session('ADMIN'), 'org_solo')
    ).resolves.toMatchObject({ complete: false });
    expect(repository.completions).toHaveLength(1);
  });
});

describe('AccountPulse Solo trial experience', () => {
  it('allows preview and ten admin-mobile test parts during an unexpired trial', () => {
    expect(
      deriveSoloTrialExperience(
        {
          subscriptionStatus: 'TRIALING',
          trialEndsAt: new Date('2026-11-24T00:00:00.000Z'),
          verifiedAdminMobile: '+61412345678'
        },
        now
      )
    ).toEqual({
      readOnly: false,
      canSync: true,
      canPreview: true,
      testSmsPartLimit: 10,
      testSmsDestination: '+61412345678',
      canSendCustomers: false,
      canEnableAutomatic: false,
      canAssignPermanentNumber: false,
      actions: []
    });
  });

  it('makes an expired unconverted trial read-only with recovery actions', () => {
    expect(
      deriveSoloTrialExperience(
        {
          subscriptionStatus: 'TRIALING',
          trialEndsAt: new Date('2026-11-09T23:59:59.000Z'),
          verifiedAdminMobile: '+61412345678'
        },
        now
      )
    ).toMatchObject({
      readOnly: true,
      canSync: false,
      canPreview: false,
      testSmsPartLimit: 0,
      testSmsDestination: null,
      canSendCustomers: false,
      canEnableAutomatic: false,
      actions: ['SUBSCRIBE', 'EXPORT', 'DISCONNECT']
    });
  });
});
