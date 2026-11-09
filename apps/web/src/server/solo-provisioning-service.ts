import { and, eq, gt, isNull, or } from 'drizzle-orm';

import type { AppSession } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  memberships,
  organisationOnboarding,
  organisations,
  subscriptions,
  users,
  xeroConnections,
  xeroPendingAuthorisations
} from '@bc5000/db/web';

export interface SoloProvisioningInput {
  userId: string;
  pendingAuthorisationId: string;
  connectionId: string;
  tenantId: string;
  now: Date;
  trialEndsAt: Date;
}

export interface SoloProvisioningRepository {
  provision(input: SoloProvisioningInput): Promise<{
    organisationId: string;
    created: boolean;
  }>;
}

const postgresErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === 'string') return value.code;
  return postgresErrorCode(value.cause);
};

const required = (value: string | undefined, code: string): string => {
  const result = value?.trim();
  if (!result) throw new Error(code);
  return result;
};

const validCurrency = (value: string): string => {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) {
    throw new Error('XERO_ORGANISATION_CURRENCY_INVALID');
  }
  return result;
};

const xeroTimeZones = new Map<string, string>([
  ['AUSEASTERNSTANDARDTIME', 'Australia/Sydney'],
  ['AUSCENTRALSTANDARDTIME', 'Australia/Adelaide'],
  ['TASMANIASTANDARDTIME', 'Australia/Hobart'],
  ['WESTERNSTANDARDTIME', 'Australia/Perth'],
  ['WAUSTRALIASTANDARDTIME', 'Australia/Perth'],
  ['NEWZEALANDSTANDARDTIME', 'Pacific/Auckland']
]);

export const accountPulseTimeZoneForXero = (value: string | null): string => {
  const source = value?.trim();
  if (!source) throw new Error('XERO_ORGANISATION_TIMEZONE_REQUIRED');
  const mapped = xeroTimeZones.get(source.toUpperCase());
  if (mapped !== undefined) return mapped;
  if (/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(source)) return source;
  throw new Error('XERO_ORGANISATION_TIMEZONE_UNSUPPORTED');
};

const existingSoloForUser = async (database: Database, userId: string) => {
  const [existing] = await database
    .select({ organisationId: organisations.id })
    .from(memberships)
    .innerJoin(
      organisations,
      eq(organisations.id, memberships.organisationId)
    )
    .where(
      and(
        eq(memberships.userId, userId),
        isNull(memberships.disabledAt),
        eq(organisations.edition, 'SOLO')
      )
    )
    .limit(1);
  return existing ?? null;
};

export const createPostgresSoloProvisioningRepository = (
  database: Database
): SoloProvisioningRepository => ({
  provision: async (input) => {
    try {
      return await database.transaction(async (transaction) => {
        const [user] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, input.userId), isNull(users.disabledAt)))
          .for('update')
          .limit(1);
        if (user === undefined) throw new Error('SOLO_IDENTITY_NOT_FOUND');

        const [existing] = await transaction
          .select({ organisationId: organisations.id })
          .from(memberships)
          .innerJoin(
            organisations,
            eq(organisations.id, memberships.organisationId)
          )
          .where(
            and(
              eq(memberships.userId, input.userId),
              isNull(memberships.disabledAt),
              eq(organisations.edition, 'SOLO')
            )
          )
          .limit(1);
        if (existing !== undefined) {
          return { organisationId: existing.organisationId, created: false };
        }

        const [pending] = await transaction
          .select()
          .from(xeroPendingAuthorisations)
          .where(
            and(
              eq(xeroPendingAuthorisations.id, input.pendingAuthorisationId),
              eq(xeroPendingAuthorisations.userId, input.userId),
              isNull(xeroPendingAuthorisations.existingOrganisationId),
              eq(xeroPendingAuthorisations.flowPurpose, 'NEW_SOLO'),
              isNull(xeroPendingAuthorisations.consumedAt),
              gt(xeroPendingAuthorisations.expiresAt, input.now)
            )
          )
          .for('update')
          .limit(1);
        if (pending === undefined) {
          throw new Error('XERO_PENDING_AUTHORISATION_INVALID');
        }
        const candidate = pending.candidateTenants.find(
          (value) =>
            value.connectionId === input.connectionId &&
            value.tenantId === input.tenantId
        );
        if (candidate === undefined) {
          throw new Error('XERO_TENANT_NOT_AUTHORISED');
        }
        const xeroOrganisationId = required(
          candidate.xeroOrganisationId,
          'XERO_ORGANISATION_DETAILS_REQUIRED'
        );
        const organisationName = required(
          candidate.organisationName,
          'XERO_ORGANISATION_DETAILS_REQUIRED'
        );
        const timeZone = required(
          candidate.timeZone,
          'XERO_ORGANISATION_TIMEZONE_REQUIRED'
        );
        const baseCurrency = validCurrency(
          required(
            candidate.baseCurrency,
            'XERO_ORGANISATION_CURRENCY_INVALID'
          )
        );

        const [owner] = await transaction
          .select({ organisationId: xeroConnections.organisationId })
          .from(xeroConnections)
          .where(
            or(
              eq(xeroConnections.connectionId, input.connectionId),
              eq(xeroConnections.tenantId, input.tenantId)
            )
          )
          .for('update')
          .limit(1);
        if (owner !== undefined) throw new Error('XERO_TENANT_ALREADY_CONNECTED');

        const [organisation] = await transaction
          .insert(organisations)
          .values({
            xeroOrganisationId,
            name: organisationName,
            timeZone,
            baseCurrency,
            edition: 'SOLO',
            sendMode: 'dry-run',
            rolloutScope: 'CONTROLLED',
            liveSendAcknowledged: false,
            operationalState: 'SYNC_REQUIRED'
          })
          .returning({ id: organisations.id });
        if (organisation === undefined) {
          throw new Error('SOLO_ORGANISATION_CREATE_FAILED');
        }
        await transaction.insert(memberships).values({
          organisationId: organisation.id,
          userId: input.userId,
          role: 'ADMIN'
        });
        await transaction.insert(subscriptions).values({
          organisationId: organisation.id,
          planCode: 'SOLO_AU_2000',
          status: 'TRIALING',
          trialEndsAt: input.trialEndsAt
        });
        await transaction.insert(organisationOnboarding).values({
          organisationId: organisation.id,
          version: 1,
          xeroConnectedAt: input.now
        });
        await transaction.insert(xeroConnections).values({
          organisationId: organisation.id,
          connectionId: input.connectionId,
          tenantId: input.tenantId,
          status: 'CONNECTED',
          encryptedRefreshToken: pending.encryptedRefreshToken,
          grantedScopes: pending.grantedScopes,
          connectedAt: input.now,
          updatedAt: input.now
        });
        await transaction.insert(auditEvents).values({
          organisationId: organisation.id,
          actorUserId: input.userId,
          eventType: 'SOLO_WORKSPACE_PROVISIONED',
          entityType: 'ORGANISATION',
          entityId: organisation.id,
          afterValue: {
            edition: 'SOLO',
            planCode: 'SOLO_AU_2000',
            sendMode: 'dry-run',
            rolloutScope: 'CONTROLLED',
            operationalState: 'SYNC_REQUIRED',
            trialEndsAt: input.trialEndsAt.toISOString()
          },
          occurredAt: input.now
        });
        await transaction
          .delete(xeroPendingAuthorisations)
          .where(eq(xeroPendingAuthorisations.id, pending.id));
        return { organisationId: organisation.id, created: true };
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        const existing = await existingSoloForUser(database, input.userId);
        if (existing !== null) {
          return { organisationId: existing.organisationId, created: false };
        }
        throw new Error('XERO_TENANT_ALREADY_CONNECTED');
      }
      throw error;
    }
  }
});

export const createSoloProvisioningService = (dependencies: {
  repository: SoloProvisioningRepository;
  clock: { now(): Date };
  ensureRecurringSchedules(organisationId: string): Promise<void>;
  publishInitialSync(
    organisationId: string,
    singletonKey: string
  ): Promise<void>;
}) => ({
  provision: async (
    session: AppSession,
    input: {
      pendingAuthorisationId: string;
      connectionId: string;
      tenantId: string;
    }
  ) => {
    const now = dependencies.clock.now();
    const provisioned = await dependencies.repository.provision({
      userId: session.userId,
      ...input,
      now,
      trialEndsAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
    });
    let initialSyncQueued = true;
    try {
      await dependencies.ensureRecurringSchedules(
        provisioned.organisationId
      );
      await dependencies.publishInitialSync(
        provisioned.organisationId,
        `xero.initial-sync:${provisioned.organisationId}`
      );
    } catch {
      initialSyncQueued = false;
    }
    return { ...provisioned, initialSyncQueued };
  }
});
