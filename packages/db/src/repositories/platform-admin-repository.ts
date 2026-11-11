import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { summariseSmsUsage } from '@bc5000/domain';

import type { Database, DbTransaction } from '../connection.js';
import {
  invitations,
  memberships,
  organisationOnboarding,
  organisations,
  platformAdminAuditEvents,
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  subscriptions,
  users,
  xeroConnections,
  type OrganisationEdition,
  type PlatformAccountStatus,
  type SmsNumberStatus,
  type SubscriptionStatus,
  type XeroConnectionStatus
} from '../schema/index.js';

const lockNumberOrganisation = async (transaction: DbTransaction, organisationId: string): Promise<boolean> => {
  const [organisation] = await transaction.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId)).for('update').limit(1);
  if (organisation === undefined) return false;
  await transaction.select({ organisationId: subscriptions.organisationId }).from(subscriptions).where(eq(subscriptions.organisationId, organisationId)).for('update').limit(1);
  return true;
};

export type PlatformOrganisationSort = 'name' | 'trialEnd' | 'status' | 'usage';
export type SortDirection = 'asc' | 'desc';

export interface PlatformOrganisationListInput {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: PlatformOrganisationSort;
  direction?: SortDirection;
}

export interface PlatformNumberListInput {
  search?: string;
  status?: SmsNumberStatus;
  page?: number;
  pageSize?: number;
}

export interface PlatformAuditListInput {
  organisationId?: string;
  actorUserId?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface PlatformSmsUsageSummary {
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  includedParts: number;
  warningPercent: number;
  committedParts: number;
  reservedParts: number;
  allowanceUpdatedAt: Date | null;
}

export interface PlatformOrganisationSummary {
  id: string;
  xeroOrganisationId: string;
  name: string;
  edition: OrganisationEdition;
  timeZone: string;
  baseCurrency: string;
  platformStatus: PlatformAccountStatus;
  platformStatusVersion: number;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  lastSuccessfulSyncAt: Date | null;
  subscription: {
    status: SubscriptionStatus;
    planCode: string;
    trialEndsAt: Date | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    updatedAt: Date;
    lastStripeEventCreatedAt: Date | null;
  } | null;
  xero: {
    tenantId: string;
    status: XeroConnectionStatus;
    connectedAt: Date;
    lastRefreshedAt: Date | null;
  } | null;
  smsNumber: PlatformNumberSummary | null;
  smsUsage: PlatformSmsUsageSummary;
  userSearchTerms: string[];
}

export interface PlatformOrganisationDetail extends PlatformOrganisationSummary {
  users: Array<{
    id: string;
    email: string;
    displayName: string;
    role: 'ADMIN' | 'OPERATOR';
    membershipVersion: number;
    userDisabledAt: Date | null;
    membershipDisabledAt: Date | null;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: 'ADMIN' | 'OPERATOR';
    status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
    version: number;
    expiresAt: Date;
    createdAt: Date;
  }>;
  onboarding: {
    version: number;
    completedVersion: number | null;
    completedAt: Date | null;
    xeroConnectedAt: Date | null;
    syncReconciledAt: Date | null;
    adminMobileVerifiedAt: Date | null;
    testSmsCompletedAt: Date | null;
    sequenceReviewedAt: Date | null;
    subscriptionReadyAt: Date | null;
    replyNumberReadyAt: Date | null;
  } | null;
}

export interface PlatformNumberSummary {
  id: string;
  e164Number: string;
  provider: string;
  providerNumberId: string | null;
  providerVerifiedAt: Date | null;
  status: SmsNumberStatus;
  organisationId: string | null;
  organisationName: string | null;
  reservedAt: Date | null;
  readyAt: Date | null;
  releasedAt: Date | null;
  quarantineUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformAuditView {
  id: string;
  actorUserId: string;
  actorEmail: string;
  actorDisplayName: string;
  targetOrganisationId: string | null;
  organisationName: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  reason: string;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  correlationId: string;
  occurredAt: Date;
}

export interface PlatformPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type PlatformOrganisationPage = PlatformPage<PlatformOrganisationSummary> & {
  metrics: {
    active: number;
    suspended: number;
    trialing: number;
  };
};
export type PlatformNumberPage = PlatformPage<PlatformNumberSummary>;
export type PlatformAuditPage = PlatformPage<PlatformAuditView>;

export interface PlatformAdminReadRepository {
  listOrganisations(input?: PlatformOrganisationListInput): Promise<PlatformOrganisationPage>;
  getOrganisationDetail(organisationId: string): Promise<PlatformOrganisationDetail | null>;
  listSmsNumbers(input?: PlatformNumberListInput): Promise<PlatformNumberPage>;
  listAuditEvents(input?: PlatformAuditListInput): Promise<PlatformAuditPage>;
}

export type PlatformMutationFailureCode =
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'VALIDATION';

export type PlatformMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PlatformMutationFailureCode };

export interface PlatformTrialMutationInput {
  actorUserId: string;
  organisationId: string;
  expectedUpdatedAt: Date;
  reason: string;
  now: Date;
}

export interface PlatformStatusMutationInput {
  actorUserId: string;
  organisationId: string;
  expectedVersion: number;
  reason: string;
  now: Date;
}

export interface PlatformNumberMutationInput {
  actorUserId: string;
  numberId: string;
  expectedUpdatedAt: Date;
  reason: string;
  now: Date;
}

export interface PlatformSmsAllowanceView extends PlatformSmsUsageSummary {
  organisationId: string;
}

export interface PlatformAdminRepository extends PlatformAdminReadRepository {
  extendTrial(
    input: PlatformTrialMutationInput & { newEnd: Date }
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>>;
  endTrial(
    input: PlatformTrialMutationInput
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>>;
  suspendOrganisation(
    input: PlatformStatusMutationInput
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>>;
  reactivateOrganisation(
    input: PlatformStatusMutationInput
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>>;
  registerSmsNumber(input: {
    actorUserId: string;
    e164Number: string;
    provider: 'SINCH';
    providerNumberId: string | null;
    reason: string;
    now: Date;
  }): Promise<PlatformMutationResult<PlatformNumberSummary>>;
  verifySmsNumberForPool(
    input: PlatformNumberMutationInput & { providerNumberId: string }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>>;
  assignSmsNumber(
    input: PlatformNumberMutationInput & {
      organisationId: string;
      expectedStatus: 'AVAILABLE' | 'RELEASED';
    }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>>;
  markSmsNumberReady(
    input: PlatformNumberMutationInput & {
      organisationId: string;
      expectedStatus: 'RESERVED';
      providerNumberId: string;
    }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>>;
  quarantineSmsNumber(
    input: PlatformNumberMutationInput & {
      expectedStatus: 'RESERVED' | 'READY';
      quarantineUntil: Date;
    }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>>;
  releaseSmsNumber(
    input: PlatformNumberMutationInput & {
      expectedStatus: 'RESERVED' | 'READY';
    }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>>;
  returnSmsNumberToPool(
    input: PlatformNumberMutationInput & { expectedStatus: 'QUARANTINED' }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>>;
  updateSmsAllowance(input: {
    actorUserId: string;
    organisationId: string;
    includedParts: number;
    warningPercent: number;
    expectedUpdatedAt: Date | null;
    reason: string;
    now: Date;
  }): Promise<PlatformMutationResult<PlatformSmsAllowanceView>>;
}

const pageValues = (page?: number, pageSize?: number) => ({
  page: Number.isInteger(page) && (page ?? 0) > 0 ? page! : 1,
  pageSize:
    Number.isInteger(pageSize) && (pageSize ?? 0) > 0
      ? Math.min(pageSize!, 100)
      : 25
});

const compareNullableDates = (left: Date | null, right: Date | null): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.getTime() - right.getTime();
};

export class PostgresPlatformAdminRepository implements PlatformAdminRepository {
  constructor(private readonly database: Database) {}

  private async organisationSummaries(): Promise<PlatformOrganisationSummary[]> {
    const [
      organisationRows,
      subscriptionRows,
      xeroRows,
      numberRows,
      allowanceRows,
      ledgerRows,
      memberRows
    ] = await Promise.all([
      this.database.select().from(organisations),
      this.database.select().from(subscriptions),
      this.database
        .select({
          organisationId: xeroConnections.organisationId,
          tenantId: xeroConnections.tenantId,
          status: xeroConnections.status,
          connectedAt: xeroConnections.connectedAt,
          lastRefreshedAt: xeroConnections.lastRefreshedAt
        })
        .from(xeroConnections),
      this.database.select().from(smsNumberPool),
      this.database.select().from(smsAllowanceSettings),
      this.database.select().from(smsUsageLedger),
      this.database
        .select({
          organisationId: memberships.organisationId,
          email: users.email,
          displayName: users.displayName
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
    ]);

    const subscriptionsByOrganisation = new Map(
      subscriptionRows.map((row) => [row.organisationId, row])
    );
    const xeroByOrganisation = new Map(
      xeroRows.map((row) => [row.organisationId, row])
    );
    const numberByOrganisation = new Map(
      numberRows
        .filter((row) => row.organisationId !== null)
        .map((row) => [row.organisationId!, row])
    );
    const allowanceByOrganisation = new Map(
      allowanceRows.map((row) => [row.organisationId, row])
    );
    const membersByOrganisation = new Map<string, string[]>();
    for (const row of memberRows) {
      const values = membersByOrganisation.get(row.organisationId) ?? [];
      values.push(row.email, row.displayName);
      membersByOrganisation.set(row.organisationId, values);
    }

    return organisationRows.map((organisation) => {
      const subscription = subscriptionsByOrganisation.get(organisation.id);
      const xero = xeroByOrganisation.get(organisation.id);
      const number = numberByOrganisation.get(organisation.id);
      const allowance = allowanceByOrganisation.get(organisation.id);
      const periodEntries =
        subscription?.currentPeriodStart && subscription.currentPeriodEnd
          ? ledgerRows.filter(
              (row) =>
                row.organisationId === organisation.id &&
                row.billingPeriodStart.getTime() ===
                  subscription.currentPeriodStart!.getTime()
            )
          : [];
      const usage = summariseSmsUsage(
        periodEntries.map((row) => ({
          entryType: row.entryType,
          partDelta: row.partDelta
        }))
      );
      const smsNumber: PlatformNumberSummary | null = number
        ? {
            ...number,
            organisationName: organisation.name
          }
        : null;
      return {
        id: organisation.id,
        xeroOrganisationId: organisation.xeroOrganisationId,
        name: organisation.name,
        edition: organisation.edition,
        timeZone: organisation.timeZone,
        baseCurrency: organisation.baseCurrency,
        platformStatus: organisation.platformStatus,
        platformStatusVersion: organisation.platformStatusVersion,
        suspendedAt: organisation.suspendedAt,
        suspensionReason: organisation.suspensionReason,
        lastSuccessfulSyncAt: organisation.lastSuccessfulSyncAt,
        subscription: subscription
          ? {
              status: subscription.status,
              planCode: subscription.planCode,
              trialEndsAt: subscription.trialEndsAt,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
              updatedAt: subscription.updatedAt,
              lastStripeEventCreatedAt: subscription.lastStripeEventCreatedAt
            }
          : null,
        xero: xero
          ? {
              tenantId: xero.tenantId,
              status: xero.status,
              connectedAt: xero.connectedAt,
              lastRefreshedAt: xero.lastRefreshedAt
            }
          : null,
        smsNumber,
        smsUsage: {
          billingPeriodStart: subscription?.currentPeriodStart ?? null,
          billingPeriodEnd: subscription?.currentPeriodEnd ?? null,
          includedParts: allowance?.includedParts ?? 2_000,
          warningPercent: allowance?.warningPercent ?? 80,
          committedParts: usage.committedParts,
          reservedParts: usage.reservedParts,
          allowanceUpdatedAt: allowance?.updatedAt ?? null
        },
        userSearchTerms: membersByOrganisation.get(organisation.id) ?? []
      };
    });
  }

  async listOrganisations(
    input: PlatformOrganisationListInput = {}
  ): Promise<PlatformOrganisationPage> {
    const { page, pageSize } = pageValues(input.page, input.pageSize);
    const query = input.search?.trim().toLocaleLowerCase() ?? '';
    let rows = await this.organisationSummaries();
    if (query) {
      rows = rows.filter((row) =>
        [
          row.name,
          row.xeroOrganisationId,
          row.xero?.tenantId ?? '',
          row.smsNumber?.e164Number ?? '',
          ...row.userSearchTerms
        ].some((value) => value.toLocaleLowerCase().includes(query))
      );
    }
    const sort = input.sort ?? 'name';
    const direction = input.direction === 'desc' ? -1 : 1;
    rows.sort((left, right) => {
      let compared = 0;
      if (sort === 'trialEnd') {
        compared = compareNullableDates(
          left.subscription?.trialEndsAt ?? null,
          right.subscription?.trialEndsAt ?? null
        );
      } else if (sort === 'status') {
        compared = `${left.platformStatus}:${left.subscription?.status ?? 'NONE'}`.localeCompare(
          `${right.platformStatus}:${right.subscription?.status ?? 'NONE'}`
        );
      } else if (sort === 'usage') {
        compared =
          left.smsUsage.committedParts + left.smsUsage.reservedParts -
          (right.smsUsage.committedParts + right.smsUsage.reservedParts);
      } else {
        compared = left.name.localeCompare(right.name);
      }
      return compared === 0 ? left.id.localeCompare(right.id) : compared * direction;
    });
    const total = rows.length;
    const metrics = {
      active: rows.filter((row) => row.platformStatus === 'ACTIVE').length,
      suspended: rows.filter((row) => row.platformStatus === 'SUSPENDED').length,
      trialing: rows.filter((row) => row.subscription?.status === 'TRIALING').length
    };
    const offset = (page - 1) * pageSize;
    return { items: rows.slice(offset, offset + pageSize), total, page, pageSize, metrics };
  }

  async getOrganisationDetail(
    organisationId: string
  ): Promise<PlatformOrganisationDetail | null> {
    const summary = (await this.organisationSummaries()).find(
      (row) => row.id === organisationId
    );
    if (!summary) return null;
    const [userRows, invitationRows, onboardingRows] = await Promise.all([
      this.database
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: memberships.role,
          membershipVersion: memberships.version,
          userDisabledAt: users.disabledAt,
          membershipDisabledAt: memberships.disabledAt
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.organisationId, organisationId))
        .orderBy(asc(users.email)),
      this.database
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          status: invitations.status,
          version: invitations.version,
          expiresAt: invitations.expiresAt,
          createdAt: invitations.createdAt
        })
        .from(invitations)
        .where(eq(invitations.organisationId, organisationId))
        .orderBy(asc(invitations.email)),
      this.database
        .select({
          version: organisationOnboarding.version,
          completedVersion: organisationOnboarding.completedVersion,
          completedAt: organisationOnboarding.completedAt,
          xeroConnectedAt: organisationOnboarding.xeroConnectedAt,
          syncReconciledAt: organisationOnboarding.syncReconciledAt,
          adminMobileVerifiedAt: organisationOnboarding.adminMobileVerifiedAt,
          testSmsCompletedAt: organisationOnboarding.testSmsCompletedAt,
          sequenceReviewedAt: organisationOnboarding.sequenceReviewedAt,
          subscriptionReadyAt: organisationOnboarding.subscriptionReadyAt,
          replyNumberReadyAt: organisationOnboarding.replyNumberReadyAt
        })
        .from(organisationOnboarding)
        .where(eq(organisationOnboarding.organisationId, organisationId))
        .limit(1)
    ]);
    return {
      ...summary,
      users: userRows,
      invitations: invitationRows,
      onboarding: onboardingRows[0] ?? null
    };
  }

  async listSmsNumbers(
    input: PlatformNumberListInput = {}
  ): Promise<PlatformNumberPage> {
    const { page, pageSize } = pageValues(input.page, input.pageSize);
    const [numberRows, organisationRows] = await Promise.all([
      this.database.select().from(smsNumberPool),
      this.database.select({ id: organisations.id, name: organisations.name }).from(organisations)
    ]);
    const names = new Map(organisationRows.map((row) => [row.id, row.name]));
    const query = input.search?.trim().toLocaleLowerCase() ?? '';
    let rows: PlatformNumberSummary[] = numberRows.map((row) => ({
      ...row,
      organisationName: row.organisationId ? names.get(row.organisationId) ?? null : null
    }));
    if (input.status) rows = rows.filter((row) => row.status === input.status);
    if (query) {
      rows = rows.filter((row) =>
        [row.e164Number, row.providerNumberId ?? '', row.organisationName ?? ''].some(
          (value) => value.toLocaleLowerCase().includes(query)
        )
      );
    }
    rows.sort((left, right) => left.e164Number.localeCompare(right.e164Number) || left.id.localeCompare(right.id));
    const total = rows.length;
    const offset = (page - 1) * pageSize;
    return { items: rows.slice(offset, offset + pageSize), total, page, pageSize };
  }

  async listAuditEvents(
    input: PlatformAuditListInput = {}
  ): Promise<PlatformAuditPage> {
    const { page, pageSize } = pageValues(input.page, input.pageSize);
    const [events, userRows, organisationRows] = await Promise.all([
      this.database.select().from(platformAdminAuditEvents),
      this.database.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users),
      this.database.select({ id: organisations.id, name: organisations.name }).from(organisations)
    ]);
    const actors = new Map(userRows.map((row) => [row.id, row]));
    const names = new Map(organisationRows.map((row) => [row.id, row.name]));
    const rows = events.filter(
      (row) =>
        (!input.organisationId || row.targetOrganisationId === input.organisationId) &&
        (!input.actorUserId || row.actorUserId === input.actorUserId) &&
        (!input.eventType || row.eventType === input.eventType) &&
        (!input.from || row.occurredAt >= input.from) &&
        (!input.to || row.occurredAt <= input.to)
    );
    rows.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id));
    const total = rows.length;
    const offset = (page - 1) * pageSize;
    return {
      items: rows.slice(offset, offset + pageSize).map((row) => {
        const actor = actors.get(row.actorUserId);
        return {
          ...row,
          actorEmail: actor?.email ?? 'unknown',
          actorDisplayName: actor?.displayName ?? 'Unknown owner',
          organisationName: row.targetOrganisationId
            ? names.get(row.targetOrganisationId) ?? null
            : null
        };
      }),
      total,
      page,
      pageSize
    };
  }

  private async updateTrial(
    input: PlatformTrialMutationInput & {
      newEnd: Date;
      eventType: 'TRIAL_EXTENDED' | 'TRIAL_ENDED';
      allowEarlierEnd: boolean;
    }
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>> {
    const result = await this.database.transaction(async (transaction) => {
      const [organisation] = await transaction
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .for('update')
        .limit(1);
      if (!organisation) return { ok: false, code: 'INVALID_STATE' } as const;
      const [subscription] = await transaction
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organisationId, input.organisationId))
        .for('update')
        .limit(1);
      if (!subscription) return { ok: false, code: 'INVALID_STATE' } as const;
      if (subscription.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (
        subscription.status !== 'TRIALING' ||
        subscription.trialEndsAt === null ||
        subscription.currentPeriodStart === null ||
        subscription.currentPeriodEnd === null
      ) {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }
      const reason = input.reason.trim();
      const maximumEnd = input.now.getTime() + 90 * 24 * 60 * 60 * 1000;
      const validEnd =
        reason.length > 0 &&
        reason.length <= 500 &&
        Number.isFinite(input.newEnd.getTime()) &&
        (input.allowEarlierEnd
          ? input.newEnd.getTime() >= input.now.getTime()
          : input.newEnd.getTime() > input.now.getTime()) &&
        input.newEnd.getTime() > subscription.currentPeriodStart.getTime() &&
        input.newEnd.getTime() <= maximumEnd &&
        (input.allowEarlierEnd ||
          input.newEnd.getTime() > subscription.trialEndsAt.getTime());
      if (!validEnd) return { ok: false, code: 'VALIDATION' } as const;

      const beforeValue = {
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt.toISOString(),
        currentPeriodStart: subscription.currentPeriodStart.toISOString(),
        currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
        updatedAt: subscription.updatedAt.toISOString()
      };
      await transaction
        .update(subscriptions)
        .set({
          trialEndsAt: input.newEnd,
          currentPeriodEnd: input.newEnd,
          updatedAt: input.now
        })
        .where(eq(subscriptions.organisationId, input.organisationId));
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: input.eventType,
        entityType: 'SUBSCRIPTION',
        entityId: input.organisationId,
        reason,
        beforeValue,
        afterValue: {
          ...beforeValue,
          trialEndsAt: input.newEnd.toISOString(),
          currentPeriodEnd: input.newEnd.toISOString(),
          updatedAt: input.now.toISOString()
        },
        occurredAt: input.now
      });
      return { ok: true } as const;
    });
    if (!result.ok) return result;
    const value = await this.getOrganisationDetail(input.organisationId);
    return value
      ? { ok: true, value }
      : { ok: false, code: 'INVALID_STATE' };
  }

  extendTrial(
    input: PlatformTrialMutationInput & { newEnd: Date }
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>> {
    return this.updateTrial({
      ...input,
      eventType: 'TRIAL_EXTENDED',
      allowEarlierEnd: false
    });
  }

  endTrial(
    input: PlatformTrialMutationInput
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>> {
    return this.updateTrial({
      ...input,
      newEnd: input.now,
      eventType: 'TRIAL_ENDED',
      allowEarlierEnd: true
    });
  }

  private async updatePlatformStatus(
    input: PlatformStatusMutationInput & {
      targetStatus: PlatformAccountStatus;
      eventType: 'ORGANISATION_SUSPENDED' | 'ORGANISATION_REACTIVATED';
    }
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>> {
    const result = await this.database.transaction(async (transaction) => {
      const [organisation] = await transaction
        .select()
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .for('update')
        .limit(1);
      if (!organisation) return { ok: false, code: 'INVALID_STATE' } as const;
      if (organisation.platformStatusVersion !== input.expectedVersion) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      const reason = input.reason.trim();
      if (reason.length === 0 || reason.length > 500) {
        return { ok: false, code: 'VALIDATION' } as const;
      }
      if (organisation.platformStatus === input.targetStatus) {
        if (
          input.targetStatus === 'SUSPENDED' &&
          organisation.suspensionReason !== reason
        ) {
          return { ok: false, code: 'INVALID_STATE' } as const;
        }
        return { ok: true } as const;
      }

      const nextVersion = organisation.platformStatusVersion + 1;
      await transaction
        .update(organisations)
        .set({
          platformStatus: input.targetStatus,
          platformStatusVersion: nextVersion,
          suspendedAt: input.targetStatus === 'SUSPENDED' ? input.now : null,
          suspensionReason: input.targetStatus === 'SUSPENDED' ? reason : null,
          updatedAt: input.now
        })
        .where(eq(organisations.id, input.organisationId));
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: input.eventType,
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        reason,
        beforeValue: {
          platformStatus: organisation.platformStatus,
          platformStatusVersion: organisation.platformStatusVersion,
          suspendedAt: organisation.suspendedAt?.toISOString() ?? null,
          suspensionReason: organisation.suspensionReason
        },
        afterValue: {
          platformStatus: input.targetStatus,
          platformStatusVersion: nextVersion,
          suspendedAt:
            input.targetStatus === 'SUSPENDED' ? input.now.toISOString() : null,
          suspensionReason: input.targetStatus === 'SUSPENDED' ? reason : null
        },
        occurredAt: input.now
      });
      return { ok: true } as const;
    });
    if (!result.ok) return result;
    const value = await this.getOrganisationDetail(input.organisationId);
    return value
      ? { ok: true, value }
      : { ok: false, code: 'INVALID_STATE' };
  }

  suspendOrganisation(
    input: PlatformStatusMutationInput
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>> {
    return this.updatePlatformStatus({
      ...input,
      targetStatus: 'SUSPENDED',
      eventType: 'ORGANISATION_SUSPENDED'
    });
  }

  reactivateOrganisation(
    input: PlatformStatusMutationInput
  ): Promise<PlatformMutationResult<PlatformOrganisationDetail>> {
    return this.updatePlatformStatus({
      ...input,
      targetStatus: 'ACTIVE',
      eventType: 'ORGANISATION_REACTIVATED'
    });
  }

  private validReason(reason: string): string | null {
    const value = reason.trim();
    return value.length > 0 && value.length <= 500 ? value : null;
  }

  private async numberSummary(
    numberId: string
  ): Promise<PlatformNumberSummary | null> {
    const [number] = await this.database
      .select()
      .from(smsNumberPool)
      .where(eq(smsNumberPool.id, numberId))
      .limit(1);
    if (!number) return null;
    const [organisation] = number.organisationId
      ? await this.database
          .select({ name: organisations.name })
          .from(organisations)
          .where(eq(organisations.id, number.organisationId))
          .limit(1)
      : [];
    return {
      ...number,
      organisationName: organisation?.name ?? null
    };
  }

  private async numberResult(
    numberId: string
  ): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    const value = await this.numberSummary(numberId);
    return value ? { ok: true, value } : { ok: false, code: 'INVALID_STATE' };
  }

  async registerSmsNumber(input: {
    actorUserId: string;
    e164Number: string;
    provider: 'SINCH';
    providerNumberId: string | null;
    reason: string;
    now: Date;
  }): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    const reason = this.validReason(input.reason);
    const providerNumberId = input.providerNumberId?.trim() || null;
    if (
      !reason ||
      input.provider !== 'SINCH' ||
      !/^\+61\d{9}$/.test(input.e164Number) ||
      (providerNumberId?.length ?? 0) > 128
    ) {
      return { ok: false, code: 'VALIDATION' };
    }
    let numberId: string | null = null;
    try {
      const result = await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`platform-number:${input.e164Number}:${providerNumberId ?? ''}`}, 0))`
        );
        const [existing] = await transaction
          .select({ id: smsNumberPool.id })
          .from(smsNumberPool)
          .where(
            or(
              eq(smsNumberPool.e164Number, input.e164Number),
              providerNumberId
                ? and(
                    eq(smsNumberPool.provider, input.provider),
                    eq(smsNumberPool.providerNumberId, providerNumberId)
                  )
                : sql`false`
            )
          )
          .limit(1);
        if (existing) return { ok: false, code: 'CONFLICT' } as const;
        const [created] = await transaction
          .insert(smsNumberPool)
          .values({
            e164Number: input.e164Number,
            provider: input.provider,
            providerNumberId,
            status: 'AVAILABLE',
            createdAt: input.now,
            updatedAt: input.now
          })
          .returning({ id: smsNumberPool.id });
        if (!created) return { ok: false, code: 'INVALID_STATE' } as const;
        await transaction.insert(platformAdminAuditEvents).values({
          actorUserId: input.actorUserId,
          eventType: 'SMS_NUMBER_REGISTERED',
          entityType: 'SMS_NUMBER',
          entityId: created.id,
          reason,
          afterValue: {
            e164Number: input.e164Number,
            provider: input.provider,
            providerNumberIdPresent: providerNumberId !== null,
            status: 'AVAILABLE'
          },
          occurredAt: input.now
        });
        numberId = created.id;
        return { ok: true } as const;
      });
      if (!result.ok) return result;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, code: 'CONFLICT' };
      }
      throw error;
    }
    return this.numberResult(numberId!);
  }

  async verifySmsNumberForPool(
    input: PlatformNumberMutationInput & { providerNumberId: string }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    const reason = this.validReason(input.reason);
    const providerNumberId = input.providerNumberId.trim();
    if (!reason || providerNumberId.length === 0 || providerNumberId.length > 128) {
      return { ok: false, code: 'VALIDATION' };
    }
    try {
      const result = await this.database.transaction(async (transaction) => {
        const [number] = await transaction
          .select()
          .from(smsNumberPool)
          .where(eq(smsNumberPool.id, input.numberId))
          .for('update')
          .limit(1);
        if (
          !number ||
          number.status !== 'AVAILABLE' ||
          number.organisationId !== null ||
          number.provider !== 'SINCH' ||
          number.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
        ) {
          return { ok: false, code: 'CONFLICT' } as const;
        }
        const [duplicate] = await transaction
          .select({ id: smsNumberPool.id })
          .from(smsNumberPool)
          .where(
            and(
              eq(smsNumberPool.provider, 'SINCH'),
              eq(smsNumberPool.providerNumberId, providerNumberId)
            )
          )
          .limit(1);
        if (duplicate && duplicate.id !== input.numberId) {
          return { ok: false, code: 'CONFLICT' } as const;
        }
        await transaction
          .update(smsNumberPool)
          .set({
            providerNumberId,
            providerVerifiedAt: input.now,
            updatedAt: input.now
          })
          .where(eq(smsNumberPool.id, input.numberId));
        await transaction.insert(platformAdminAuditEvents).values({
          actorUserId: input.actorUserId,
          eventType: 'SMS_NUMBER_POOL_VERIFIED',
          entityType: 'SMS_NUMBER',
          entityId: input.numberId,
          reason,
          beforeValue: {
            status: number.status,
            providerNumberIdPresent: number.providerNumberId !== null,
            providerVerified: number.providerVerifiedAt !== null
          },
          afterValue: {
            status: 'AVAILABLE',
            providerNumberIdPresent: true,
            providerVerified: true,
            providerVerifiedAt: input.now.toISOString()
          },
          occurredAt: input.now
        });
        return { ok: true } as const;
      });
      return result.ok ? this.numberResult(input.numberId) : result;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, code: 'CONFLICT' };
      }
      throw error;
    }
  }

  async assignSmsNumber(
    input: PlatformNumberMutationInput & {
      organisationId: string;
      expectedStatus: 'AVAILABLE' | 'RELEASED';
    }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    const reason = this.validReason(input.reason);
    if (!reason || !['AVAILABLE', 'RELEASED'].includes(input.expectedStatus)) {
      return { ok: false, code: 'VALIDATION' };
    }
    const result = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`platform-org-number:${input.organisationId}`}, 0))`
      );
      if (!(await lockNumberOrganisation(transaction, input.organisationId))) return { ok: false, code: 'INVALID_STATE' } as const;
      const [number] = await transaction
        .select()
        .from(smsNumberPool)
        .where(eq(smsNumberPool.id, input.numberId))
        .for('update')
        .limit(1);
      if (!number || number.status !== input.expectedStatus) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (number.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      const [organisation] = await transaction
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .limit(1);
      if (!organisation) return { ok: false, code: 'INVALID_STATE' } as const;
      const [active] = await transaction
        .select({ id: smsNumberPool.id })
        .from(smsNumberPool)
        .where(
          and(
            eq(smsNumberPool.organisationId, input.organisationId),
            inArray(smsNumberPool.status, ['RESERVED', 'READY', 'QUARANTINED'])
          )
        )
        .limit(1);
      if (active) return { ok: false, code: 'INVALID_STATE' } as const;
      await transaction
        .update(smsNumberPool)
        .set({
          status: 'RESERVED',
          organisationId: input.organisationId,
          reservedAt: input.now,
          readyAt: null,
          releasedAt: null,
          quarantineUntil: null,
          updatedAt: input.now
        })
        .where(eq(smsNumberPool.id, input.numberId));
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: 'SMS_NUMBER_ASSIGNED',
        entityType: 'SMS_NUMBER',
        entityId: input.numberId,
        reason,
        beforeValue: { status: number.status, organisationId: null },
        afterValue: { status: 'RESERVED', organisationId: input.organisationId },
        occurredAt: input.now
      });
      return { ok: true } as const;
    });
    return result.ok ? this.numberResult(input.numberId) : result;
  }

  async markSmsNumberReady(
    input: PlatformNumberMutationInput & {
      organisationId: string;
      expectedStatus: 'RESERVED';
      providerNumberId: string;
    }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    const reason = this.validReason(input.reason);
    const providerNumberId = input.providerNumberId.trim();
    if (!reason || providerNumberId.length === 0 || providerNumberId.length > 128) {
      return { ok: false, code: 'VALIDATION' };
    }
    try {
      const result = await this.database.transaction(async (transaction) => {
        if (!(await lockNumberOrganisation(transaction, input.organisationId))) return { ok: false, code: 'INVALID_STATE' } as const;
        const [number] = await transaction
          .select()
          .from(smsNumberPool)
          .where(eq(smsNumberPool.id, input.numberId))
          .for('update')
          .limit(1);
        if (
          !number ||
          number.status !== input.expectedStatus ||
          number.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() ||
          number.organisationId !== input.organisationId
        ) {
          return { ok: false, code: 'CONFLICT' } as const;
        }
        const [duplicate] = await transaction
          .select({ id: smsNumberPool.id })
          .from(smsNumberPool)
          .where(
            and(
              eq(smsNumberPool.provider, number.provider),
              eq(smsNumberPool.providerNumberId, providerNumberId)
            )
          )
          .limit(1);
        if (duplicate && duplicate.id !== input.numberId) {
          return { ok: false, code: 'CONFLICT' } as const;
        }
        await transaction
          .update(smsNumberPool)
          .set({
            providerNumberId,
            providerVerifiedAt: input.now,
            status: 'READY',
            readyAt: input.now,
            updatedAt: input.now
          })
          .where(eq(smsNumberPool.id, input.numberId));
        await transaction
          .insert(organisationOnboarding)
          .values({
            organisationId: input.organisationId,
            replyNumberReadyAt: input.now,
            updatedAt: input.now
          })
          .onConflictDoUpdate({
            target: organisationOnboarding.organisationId,
            set: { replyNumberReadyAt: input.now, updatedAt: input.now }
          });
        await transaction.insert(platformAdminAuditEvents).values({
          actorUserId: input.actorUserId,
          targetOrganisationId: input.organisationId,
          eventType: 'SMS_NUMBER_READY',
          entityType: 'SMS_NUMBER',
          entityId: input.numberId,
          reason,
          beforeValue: { status: number.status },
          afterValue: {
            status: 'READY',
            providerNumberIdPresent: true,
            verifiedAt: input.now.toISOString()
          },
          occurredAt: input.now
        });
        return { ok: true } as const;
      });
      return result.ok ? this.numberResult(input.numberId) : result;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, code: 'CONFLICT' };
      }
      throw error;
    }
  }

  private async placeNumberInQuarantine(input: PlatformNumberMutationInput & {
    expectedStatus: 'RESERVED' | 'READY';
    quarantineUntil: Date;
    eventType: 'SMS_NUMBER_QUARANTINED' | 'SMS_NUMBER_RELEASED';
  }): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    const reason = this.validReason(input.reason);
    if (
      !reason ||
      !Number.isFinite(input.quarantineUntil.getTime()) ||
      input.quarantineUntil.getTime() <
        input.now.getTime() + 30 * 24 * 60 * 60 * 1000
    ) {
      return { ok: false, code: 'VALIDATION' };
    }
    const result = await this.database.transaction(async (transaction) => {
      const [owner] = await transaction.select({ organisationId: smsNumberPool.organisationId }).from(smsNumberPool).where(eq(smsNumberPool.id, input.numberId)).limit(1);
      if (!owner?.organisationId || !(await lockNumberOrganisation(transaction, owner.organisationId))) return { ok: false, code: 'CONFLICT' } as const;
      const [number] = await transaction
        .select()
        .from(smsNumberPool)
        .where(eq(smsNumberPool.id, input.numberId))
        .for('update')
        .limit(1);
      if (
        !number ||
        number.status !== input.expectedStatus ||
        number.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() ||
        !number.organisationId || number.organisationId !== owner.organisationId
      ) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      await transaction
        .update(smsNumberPool)
        .set({
          status: 'QUARANTINED',
          providerVerifiedAt: null,
          quarantineUntil: input.quarantineUntil,
          releasedAt: input.eventType === 'SMS_NUMBER_RELEASED' ? input.now : number.releasedAt,
          updatedAt: input.now
        })
        .where(eq(smsNumberPool.id, input.numberId));
      await transaction
        .update(organisationOnboarding)
        .set({ replyNumberReadyAt: null, updatedAt: input.now })
        .where(eq(organisationOnboarding.organisationId, number.organisationId));
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: number.organisationId,
        eventType: input.eventType,
        entityType: 'SMS_NUMBER',
        entityId: input.numberId,
        reason,
        beforeValue: { status: number.status },
        afterValue: {
          status: 'QUARANTINED',
          quarantineUntil: input.quarantineUntil.toISOString()
        },
        occurredAt: input.now
      });
      return { ok: true } as const;
    });
    return result.ok ? this.numberResult(input.numberId) : result;
  }

  quarantineSmsNumber(
    input: PlatformNumberMutationInput & {
      expectedStatus: 'RESERVED' | 'READY';
      quarantineUntil: Date;
    }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    return this.placeNumberInQuarantine({
      ...input,
      eventType: 'SMS_NUMBER_QUARANTINED'
    });
  }

  releaseSmsNumber(
    input: PlatformNumberMutationInput & { expectedStatus: 'RESERVED' | 'READY' }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    return this.placeNumberInQuarantine({
      ...input,
      quarantineUntil: new Date(input.now.getTime() + 30 * 24 * 60 * 60 * 1000),
      eventType: 'SMS_NUMBER_RELEASED'
    });
  }

  async returnSmsNumberToPool(
    input: PlatformNumberMutationInput & { expectedStatus: 'QUARANTINED' }
  ): Promise<PlatformMutationResult<PlatformNumberSummary>> {
    const reason = this.validReason(input.reason);
    if (!reason) return { ok: false, code: 'VALIDATION' };
    const result = await this.database.transaction(async (transaction) => {
      const [owner] = await transaction.select({ organisationId: smsNumberPool.organisationId }).from(smsNumberPool).where(eq(smsNumberPool.id, input.numberId)).limit(1);
      if (!owner?.organisationId || !(await lockNumberOrganisation(transaction, owner.organisationId))) return { ok: false, code: 'CONFLICT' } as const;
      const [number] = await transaction
        .select()
        .from(smsNumberPool)
        .where(eq(smsNumberPool.id, input.numberId))
        .for('update')
        .limit(1);
      if (
        !number ||
        number.status !== input.expectedStatus ||
        number.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() ||
        number.organisationId !== owner.organisationId
      ) {
        return { ok: false, code: 'CONFLICT' } as const;
      }
      if (
        !number.organisationId ||
        !number.quarantineUntil ||
        number.quarantineUntil.getTime() > input.now.getTime()
      ) {
        return { ok: false, code: 'INVALID_STATE' } as const;
      }
      const formerOrganisationId = number.organisationId;
      await transaction
        .update(smsNumberPool)
        .set({
          status: 'AVAILABLE',
          organisationId: null,
          providerVerifiedAt: null,
          reservedAt: null,
          readyAt: null,
          quarantineUntil: null,
          updatedAt: input.now
        })
        .where(eq(smsNumberPool.id, input.numberId));
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: formerOrganisationId,
        eventType: 'SMS_NUMBER_RETURNED_TO_POOL',
        entityType: 'SMS_NUMBER',
        entityId: input.numberId,
        reason,
        beforeValue: {
          status: number.status,
          organisationId: formerOrganisationId,
          quarantineUntil: number.quarantineUntil.toISOString()
        },
        afterValue: { status: 'AVAILABLE', organisationId: null },
        occurredAt: input.now
      });
      return { ok: true } as const;
    });
    return result.ok ? this.numberResult(input.numberId) : result;
  }

  async updateSmsAllowance(input: {
    actorUserId: string;
    organisationId: string;
    includedParts: number;
    warningPercent: number;
    expectedUpdatedAt: Date | null;
    reason: string;
    now: Date;
  }): Promise<PlatformMutationResult<PlatformSmsAllowanceView>> {
    const reason = this.validReason(input.reason);
    if (
      !reason ||
      !Number.isSafeInteger(input.includedParts) ||
      input.includedParts < 1 ||
      input.includedParts > 1_000_000 ||
      !Number.isSafeInteger(input.warningPercent) ||
      input.warningPercent < 1 ||
      input.warningPercent > 100
    ) {
      return { ok: false, code: 'VALIDATION' };
    }
    const value = await this.database.transaction(async (transaction) => {
      const [organisation] = await transaction
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, input.organisationId))
        .for('update')
        .limit(1);
      if (!organisation) return null;
      const [before] = await transaction
        .select()
        .from(smsAllowanceSettings)
        .where(eq(smsAllowanceSettings.organisationId, input.organisationId))
        .for('update')
        .limit(1);
      if (
        (before === undefined && input.expectedUpdatedAt !== null) ||
        (before !== undefined &&
          (input.expectedUpdatedAt === null ||
            before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()))
      ) {
        return { kind: 'conflict' } as const;
      }
      await transaction
        .insert(smsAllowanceSettings)
        .values({
          organisationId: input.organisationId,
          includedParts: input.includedParts,
          warningPercent: input.warningPercent,
          updatedAt: input.now
        })
        .onConflictDoUpdate({
          target: smsAllowanceSettings.organisationId,
          set: {
            includedParts: input.includedParts,
            warningPercent: input.warningPercent,
            updatedAt: input.now
          }
        });
      const [subscription] = await transaction
        .select({
          currentPeriodStart: subscriptions.currentPeriodStart,
          currentPeriodEnd: subscriptions.currentPeriodEnd
        })
        .from(subscriptions)
        .where(eq(subscriptions.organisationId, input.organisationId))
        .limit(1);
      const entries = subscription?.currentPeriodStart && subscription.currentPeriodEnd
        ? await transaction
            .select({
              entryType: smsUsageLedger.entryType,
              partDelta: smsUsageLedger.partDelta
            })
            .from(smsUsageLedger)
            .where(
              and(
                eq(smsUsageLedger.organisationId, input.organisationId),
                eq(smsUsageLedger.billingPeriodStart, subscription.currentPeriodStart)
              )
            )
        : [];
      const usage = summariseSmsUsage(entries);
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: input.organisationId,
        eventType: 'SMS_ALLOWANCE_UPDATED',
        entityType: 'SMS_ALLOWANCE',
        entityId: input.organisationId,
        reason,
        beforeValue: before
          ? {
              includedParts: before.includedParts,
              warningPercent: before.warningPercent
            }
          : null,
        afterValue: {
          includedParts: input.includedParts,
          warningPercent: input.warningPercent
        },
        occurredAt: input.now
      });
      return {
        kind: 'updated',
        value: {
          organisationId: input.organisationId,
          billingPeriodStart: subscription?.currentPeriodStart ?? null,
          billingPeriodEnd: subscription?.currentPeriodEnd ?? null,
          includedParts: input.includedParts,
          warningPercent: input.warningPercent,
          committedParts: usage.committedParts,
          reservedParts: usage.reservedParts,
          allowanceUpdatedAt: input.now
        }
      } as const;
    });
    if (value === null) return { ok: false, code: 'INVALID_STATE' };
    if (value.kind === 'conflict') return { ok: false, code: 'CONFLICT' };
    return { ok: true, value: value.value };
  }
}
