import { and, eq, inArray } from 'drizzle-orm';

import {
  decideAccountEntitlements,
  renderSms,
  type AccountEntitlements
} from '@bc5000/domain';

import type { Database, DbTransaction } from '../connection.js';
import {
  organisationOnboarding,
  organisations,
  outboundMessages,
  subscriptions
} from '../schema/index.js';

type Executor = Database | DbTransaction;

export class PostgresEntitlementRepository {
  constructor(private readonly database: Database) {}

  async decide(
    organisationId: string,
    now: Date,
    executor: Executor = this.database
  ): Promise<AccountEntitlements> {
    const [account] = await executor
      .select({
        edition: organisations.edition,
        subscriptionStatus: subscriptions.status,
        trialEndsAt: subscriptions.trialEndsAt,
        onboardingVersion: organisationOnboarding.version,
        onboardingCompletedVersion: organisationOnboarding.completedVersion,
        adminMobile: organisationOnboarding.adminMobile,
        adminMobileVerifiedAt: organisationOnboarding.adminMobileVerifiedAt,
        replyNumberReadyAt: organisationOnboarding.replyNumberReadyAt
      })
      .from(organisations)
      .leftJoin(
        subscriptions,
        eq(subscriptions.organisationId, organisations.id)
      )
      .leftJoin(
        organisationOnboarding,
        eq(organisationOnboarding.organisationId, organisations.id)
      )
      .where(eq(organisations.id, organisationId))
      .limit(1);
    if (account === undefined) throw new Error('ORGANISATION_NOT_FOUND');

    if (account.edition === 'INTERNAL_LEGACY') {
      return decideAccountEntitlements({
        edition: account.edition,
        subscriptionStatus: null,
        trialEndsAt: null,
        onboardingCompletedVersion: null,
        requiredOnboardingVersion: 1,
        replyNumberReady: false,
        verifiedAdminMobile: null,
        acceptedTrialTestSmsParts: 0,
        now
      });
    }
    if (
      account.subscriptionStatus === null ||
      account.onboardingVersion === null
    ) {
      throw new Error('SOLO_COMMERCE_STATE_MISSING');
    }

    const acceptedTests = await executor
      .select({ content: outboundMessages.content })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.organisationId, organisationId),
          eq(outboundMessages.source, 'TEST_SMS'),
          inArray(outboundMessages.status, ['ACCEPTED', 'DELIVERED'])
        )
      );
    const acceptedTrialTestSmsParts = acceptedTests.reduce(
      (total, message) => {
        if (message.content === null) return total;
        try {
          return (
            total +
            renderSms(message.content, {}, { maxSegments: 10 }).segmentCount
          );
        } catch {
          return total + 10;
        }
      },
      0
    );

    return decideAccountEntitlements({
      edition: account.edition,
      subscriptionStatus: account.subscriptionStatus,
      trialEndsAt: account.trialEndsAt,
      onboardingCompletedVersion: account.onboardingCompletedVersion,
      requiredOnboardingVersion: account.onboardingVersion,
      replyNumberReady: account.replyNumberReadyAt !== null,
      verifiedAdminMobile:
        account.adminMobileVerifiedAt === null ? null : account.adminMobile,
      acceptedTrialTestSmsParts,
      now
    });
  }
}
