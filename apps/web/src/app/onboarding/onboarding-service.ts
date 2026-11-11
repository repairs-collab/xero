import { and, eq, inArray } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  organisationOnboarding,
  type OperationalState,
  organisations,
  outboundMessages,
  reminderSequences,
  smsNumberPool,
  subscriptions,
  type SubscriptionStatus,
  xeroConnections,
  type XeroConnectionStatus
} from '@bc5000/db/web';

export type OnboardingStepKey =
  | 'XERO_CONNECTED'
  | 'SYNC_RECONCILED'
  | 'BUSINESS_DETAILS'
  | 'ADMIN_MOBILE_VERIFIED'
  | 'TEST_SMS_COMPLETED'
  | 'SEQUENCE_REVIEWED'
  | 'SUBSCRIPTION_ACTIVE'
  | 'REPLY_NUMBER_READY';

export interface OnboardingEvidence {
  xeroConnectionStatus: XeroConnectionStatus | null;
  operationalState: OperationalState;
  lastSuccessfulSyncAt: Date | null;
  latestReconciledSyncAt: Date | null;
  businessDetailsCompletedAt: Date | null;
  adminMobile: string | null;
  adminMobileVerifiedAt: Date | null;
  acceptedTestSmsParts: number;
  sequenceCount: number;
  allSequencesInReview: boolean;
  sequenceReviewedAt: Date | null;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  replyNumberStatus: 'READY' | null;
}

export interface OnboardingStep {
  key: OnboardingStepKey;
  label: string;
  description: string;
  href: string;
  complete: boolean;
}

export interface OnboardingRepository {
  load(organisationId: string): Promise<OnboardingEvidence>;
  recordAttestation(input: {
    organisationId: string;
    userId: string;
    kind: 'BUSINESS_DETAILS' | 'SEQUENCE_REVIEW';
    occurredAt: Date;
  }): Promise<void>;
  markCompleted(input: {
    organisationId: string;
    userId: string;
    version: number;
    occurredAt: Date;
  }): Promise<void>;
}

export const createPostgresOnboardingRepository = (
  database: Database,
  evidenceProviders: {
    verifiedAdminMobile?(organisationId: string): Promise<{
      number: string;
      verifiedAt: Date;
    } | null>;
    replyNumberStatus?(
      organisationId: string
    ): Promise<'READY' | null>;
  } = {}
): OnboardingRepository => ({
  load: async (organisationId) => {
    await database
      .insert(organisationOnboarding)
      .values({ organisationId, version: 1 })
      .onConflictDoNothing();
    const [base] = await database
      .select({
        operationalState: organisations.operationalState,
        lastSuccessfulSyncAt: organisations.lastSuccessfulSyncAt,
        latestReconciledSyncAt: organisations.latestReconciledSyncAt,
        businessDetailsCompletedAt:
          organisationOnboarding.businessDetailsCompletedAt,
        adminMobile: organisationOnboarding.adminMobile,
        adminMobileVerifiedAt: organisationOnboarding.adminMobileVerifiedAt,
        sequenceReviewedAt: organisationOnboarding.sequenceReviewedAt,
        subscriptionStatus: subscriptions.status,
        trialEndsAt: subscriptions.trialEndsAt
      })
      .from(organisations)
      .innerJoin(
        organisationOnboarding,
        eq(organisationOnboarding.organisationId, organisations.id)
      )
      .innerJoin(
        subscriptions,
        eq(subscriptions.organisationId, organisations.id)
      )
      .where(eq(organisations.id, organisationId))
      .limit(1);
    if (base === undefined) throw new Error('ONBOARDING_NOT_FOUND');

    const [xeroConnection] = await database
      .select({ status: xeroConnections.status })
      .from(xeroConnections)
      .where(eq(xeroConnections.organisationId, organisationId))
      .limit(1);
    const acceptedTests = await database
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.organisationId, organisationId),
          eq(outboundMessages.source, 'TEST_SMS'),
          inArray(outboundMessages.status, ['ACCEPTED', 'DELIVERED'])
        )
      );
    const sequences = await database
      .select({ mode: reminderSequences.mode })
      .from(reminderSequences)
      .where(eq(reminderSequences.organisationId, organisationId));
    const verifiedMobile =
      (await evidenceProviders.verifiedAdminMobile?.(organisationId)) ?? null;
    const [storedReplyNumber] = await database
      .select({ status: smsNumberPool.status })
      .from(smsNumberPool)
      .where(
        and(
          eq(smsNumberPool.organisationId, organisationId),
          eq(smsNumberPool.status, 'READY')
        )
      )
      .limit(1);
    const replyNumberStatus =
      (await evidenceProviders.replyNumberStatus?.(organisationId)) ??
      (storedReplyNumber?.status === 'READY' ? 'READY' : null);
    return {
      xeroConnectionStatus: xeroConnection?.status ?? null,
      operationalState: base.operationalState,
      lastSuccessfulSyncAt: base.lastSuccessfulSyncAt,
      latestReconciledSyncAt: base.latestReconciledSyncAt,
      businessDetailsCompletedAt: base.businessDetailsCompletedAt,
      adminMobile: verifiedMobile?.number ?? base.adminMobile,
      adminMobileVerifiedAt:
        verifiedMobile?.verifiedAt ?? base.adminMobileVerifiedAt,
      acceptedTestSmsParts: acceptedTests.length,
      sequenceCount: sequences.length,
      allSequencesInReview:
        sequences.length > 0 && sequences.every((row) => row.mode === 'REVIEW'),
      sequenceReviewedAt: base.sequenceReviewedAt,
      subscriptionStatus: base.subscriptionStatus,
      trialEndsAt: base.trialEndsAt,
      replyNumberStatus
    };
  },
  recordAttestation: async (input) => {
    await database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ organisationId: organisationOnboarding.organisationId })
        .from(organisationOnboarding)
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        )
        .for('update')
        .limit(1);
      if (current === undefined) throw new Error('ONBOARDING_NOT_FOUND');
      if (input.kind === 'SEQUENCE_REVIEW') {
        const sequences = await transaction
          .select({ mode: reminderSequences.mode })
          .from(reminderSequences)
          .where(
            eq(reminderSequences.organisationId, input.organisationId)
          );
        if (
          sequences.length < 1 ||
          sequences.some((sequence) => sequence.mode !== 'REVIEW')
        ) {
          throw new Error('SEQUENCES_NOT_READY_FOR_REVIEW');
        }
      }
      await transaction
        .update(organisationOnboarding)
        .set({
          ...(input.kind === 'BUSINESS_DETAILS'
            ? { businessDetailsCompletedAt: input.occurredAt }
            : { sequenceReviewedAt: input.occurredAt }),
          updatedAt: input.occurredAt
        })
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: input.userId,
        eventType: 'ONBOARDING_ATTESTATION_RECORDED',
        entityType: 'ORGANISATION_ONBOARDING',
        entityId: input.organisationId,
        afterValue: { kind: input.kind, version: 1 },
        occurredAt: input.occurredAt
      });
    });
  },
  markCompleted: async (input) => {
    await database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({
          version: organisationOnboarding.version,
          completedVersion: organisationOnboarding.completedVersion
        })
        .from(organisationOnboarding)
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        )
        .for('update')
        .limit(1);
      if (current === undefined) throw new Error('ONBOARDING_NOT_FOUND');
      if (
        current.completedVersion !== null &&
        current.completedVersion >= input.version
      ) {
        return;
      }
      if (input.version !== current.version) {
        throw new Error('ONBOARDING_VERSION_MISMATCH');
      }
      await transaction
        .update(organisationOnboarding)
        .set({
          completedVersion: input.version,
          completedAt: input.occurredAt,
          updatedAt: input.occurredAt
        })
        .where(
          eq(organisationOnboarding.organisationId, input.organisationId)
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: input.userId,
        eventType: 'ONBOARDING_COMPLETED',
        entityType: 'ORGANISATION_ONBOARDING',
        entityId: input.organisationId,
        afterValue: { version: input.version },
        occurredAt: input.occurredAt
      });
    });
  }
});

const sameInstant = (left: Date | null, right: Date | null): boolean =>
  left !== null && right !== null && left.getTime() === right.getTime();

const verifiedAustralianMobile = (input: OnboardingEvidence): boolean =>
  input.adminMobileVerifiedAt !== null &&
  input.adminMobile !== null &&
  /^\+614\d{8}$/.test(input.adminMobile);

export const deriveOnboardingStatus = (
  input: OnboardingEvidence
): {
  steps: OnboardingStep[];
  completedCount: number;
  complete: boolean;
} => {
  const steps: OnboardingStep[] = [
    {
      key: 'XERO_CONNECTED',
      label: 'Connect Xero',
      description: 'A current Xero organisation connection is required.',
      href: '/settings/integrations',
      complete: input.xeroConnectionStatus === 'CONNECTED'
    },
    {
      key: 'SYNC_RECONCILED',
      label: 'Reconcile the first sync',
      description: 'Confirm the latest AccountPulse totals match Xero.',
      href: '/settings/sending',
      complete:
        input.operationalState === 'RECONCILED' &&
        sameInstant(
          input.lastSuccessfulSyncAt,
          input.latestReconciledSyncAt
        )
    },
    {
      key: 'BUSINESS_DETAILS',
      label: 'Confirm business and support details',
      description: 'Review the business identity customers will see.',
      href: '/onboarding#business-details',
      complete: input.businessDetailsCompletedAt !== null
    },
    {
      key: 'ADMIN_MOBILE_VERIFIED',
      label: 'Verify the Administrator mobile',
      description: 'Verify an Australian mobile before sending trial tests.',
      href: '/settings/test-sms',
      complete: verifiedAustralianMobile(input)
    },
    {
      key: 'TEST_SMS_COMPLETED',
      label: 'Complete a test SMS',
      description: 'Send at least one accepted test to the verified mobile.',
      href: '/settings/test-sms',
      complete:
        verifiedAustralianMobile(input) && input.acceptedTestSmsParts > 0
    },
    {
      key: 'SEQUENCE_REVIEWED',
      label: 'Review reminder sequences',
      description: 'Keep every sequence in Review mode for first use.',
      href: '/sequences',
      complete:
        input.sequenceReviewedAt !== null &&
        input.sequenceCount > 0 &&
        input.allSequencesInReview
    },
    {
      key: 'SUBSCRIPTION_ACTIVE',
      label: 'Activate the subscription',
      description: 'Subscribe through Stripe when the trial is ready.',
      href: '/settings/billing',
      complete:
        input.subscriptionStatus === 'ACTIVE' ||
        input.subscriptionStatus === 'CANCEL_AT_PERIOD_END'
    },
    {
      key: 'REPLY_NUMBER_READY',
      label: 'Provision the reply number',
      description: 'A dedicated Australian reply number must be verified.',
      href: '/settings/billing',
      complete: input.replyNumberStatus === 'READY'
    }
  ];
  const completedCount = steps.filter((step) => step.complete).length;
  return {
    steps,
    completedCount,
    complete: completedCount === steps.length
  };
};
export const createOnboardingService = (dependencies: {
  repository: OnboardingRepository;
  clock: { now(): Date };
}) => {
  const getStatus = async (
    session: AppSession,
    organisationId: string
  ) => {
    authorise(session, 'audit.read', organisationId);
    const now = dependencies.clock.now();
    const evidence = await dependencies.repository.load(organisationId);
    const status = deriveOnboardingStatus(evidence);
    if (status.complete) {
      await dependencies.repository.markCompleted({
        organisationId,
        userId: session.userId,
        version: 1,
        occurredAt: now
      });
    }
    return {
      ...status,
      trial: deriveSoloTrialExperience(
        {
          subscriptionStatus: evidence.subscriptionStatus,
          trialEndsAt: evidence.trialEndsAt,
          verifiedAdminMobile: verifiedAustralianMobile(evidence)
            ? evidence.adminMobile
            : null
        },
        now
      )
    };
  };

  const confirmBusinessDetails = async (
    session: AppSession,
    organisationId: string
  ): Promise<void> => {
    authorise(session, 'provider.configure', organisationId);
    await dependencies.repository.recordAttestation({
      organisationId,
      userId: session.userId,
      kind: 'BUSINESS_DETAILS',
      occurredAt: dependencies.clock.now()
    });
  };

  const confirmSequenceReview = async (
    session: AppSession,
    organisationId: string
  ): Promise<void> => {
    authorise(session, 'sequence.manage', organisationId);
    const current = await dependencies.repository.load(organisationId);
    if (current.sequenceCount < 1 || !current.allSequencesInReview) {
      throw new Error('SEQUENCES_NOT_READY_FOR_REVIEW');
    }
    await dependencies.repository.recordAttestation({
      organisationId,
      userId: session.userId,
      kind: 'SEQUENCE_REVIEW',
      occurredAt: dependencies.clock.now()
    });
  };

  return { getStatus, confirmBusinessDetails, confirmSequenceReview };
};

export interface SoloTrialInput {
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  verifiedAdminMobile: string | null;
}

export interface SoloTrialExperience {
  readOnly: boolean;
  canSync: boolean;
  canPreview: boolean;
  testSmsPartLimit: number;
  testSmsDestination: string | null;
  canSendCustomers: boolean;
  canEnableAutomatic: boolean;
  canAssignPermanentNumber: boolean;
  actions: Array<'SUBSCRIBE' | 'EXPORT' | 'DISCONNECT'>;
}

export const deriveSoloTrialExperience = (
  input: SoloTrialInput,
  now: Date
): SoloTrialExperience => {
  const validMobile =
    input.verifiedAdminMobile !== null &&
    /^\+614\d{8}$/.test(input.verifiedAdminMobile)
      ? input.verifiedAdminMobile
      : null;
  const trialCurrent =
    input.subscriptionStatus === 'TRIALING' &&
    input.trialEndsAt !== null &&
    input.trialEndsAt.getTime() > now.getTime();
  if (trialCurrent) {
    return {
      readOnly: false,
      canSync: true,
      canPreview: true,
      testSmsPartLimit: 10,
      testSmsDestination: validMobile,
      canSendCustomers: false,
      canEnableAutomatic: false,
      canAssignPermanentNumber: false,
      actions: []
    };
  }
  const paid =
    input.subscriptionStatus === 'ACTIVE' ||
    input.subscriptionStatus === 'CANCEL_AT_PERIOD_END';
  if (paid) {
    return {
      readOnly: false,
      canSync: true,
      canPreview: true,
      testSmsPartLimit: 0,
      testSmsDestination: validMobile,
      canSendCustomers: false,
      canEnableAutomatic: false,
      canAssignPermanentNumber: true,
      actions: []
    };
  }
  return {
    readOnly: true,
    canSync: false,
    canPreview: false,
    testSmsPartLimit: 0,
    testSmsDestination: null,
    canSendCustomers: false,
    canEnableAutomatic: false,
    canAssignPermanentNumber: false,
    actions: ['SUBSCRIBE', 'EXPORT', 'DISCONNECT']
  };
};
