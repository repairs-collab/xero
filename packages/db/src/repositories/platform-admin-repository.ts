import { asc, eq } from 'drizzle-orm';

import { summariseSmsUsage } from '@bc5000/domain';

import type { Database } from '../connection.js';
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
    userDisabledAt: Date | null;
    membershipDisabledAt: Date | null;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: 'ADMIN' | 'OPERATOR';
    status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
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

export type PlatformOrganisationPage = PlatformPage<PlatformOrganisationSummary>;
export type PlatformNumberPage = PlatformPage<PlatformNumberSummary>;
export type PlatformAuditPage = PlatformPage<PlatformAuditView>;

export interface PlatformAdminReadRepository {
  listOrganisations(input?: PlatformOrganisationListInput): Promise<PlatformOrganisationPage>;
  getOrganisationDetail(organisationId: string): Promise<PlatformOrganisationDetail | null>;
  listSmsNumbers(input?: PlatformNumberListInput): Promise<PlatformNumberPage>;
  listAuditEvents(input?: PlatformAuditListInput): Promise<PlatformAuditPage>;
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

export class PostgresPlatformAdminRepository implements PlatformAdminReadRepository {
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
                  subscription.currentPeriodStart!.getTime() &&
                row.billingPeriodEnd.getTime() === subscription.currentPeriodEnd!.getTime()
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
          reservedParts: usage.reservedParts
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
    const offset = (page - 1) * pageSize;
    return { items: rows.slice(offset, offset + pageSize), total, page, pageSize };
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
    let rows = events.filter(
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
}
