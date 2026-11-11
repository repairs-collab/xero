import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { AuthorizationFailure, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  organisationOnboarding,
  organisations,
  platformAdminAuditEvents,
  smsAllowanceSettings,
  subscriptions
} from '@bc5000/db/web';

import { getDatabaseClient } from './runtime.js';
import { isPlatformOwner } from './platform-authorization.js';
import { getPlatformUserAdministration } from './platform-user-administration.js';

export interface CreatePlatformCustomerInput {
  name: string;
  adminEmail: string;
  adminDisplayName: string;
  timeZone: 'Australia/Sydney' | 'Australia/Adelaide' | 'Australia/Perth' | 'Pacific/Auckland';
  baseCurrency: 'AUD' | 'NZD';
  trialDays: number;
  includedSmsParts: number;
  warningPercent: number;
  reason: string;
}

interface WorkspaceInput extends Omit<CreatePlatformCustomerInput, 'adminEmail' | 'adminDisplayName' | 'trialDays'> {
  actorUserId: string;
  trialEndsAt: Date;
  now: Date;
}

export interface PlatformCustomerProvisioningRepository {
  createWorkspace(input: WorkspaceInput): Promise<{ organisationId: string }>;
  removeFailedWorkspace(organisationId: string): Promise<void>;
}

export const createPostgresPlatformCustomerProvisioningRepository = (
  database: Database
): PlatformCustomerProvisioningRepository => ({
  createWorkspace: (input) =>
    database.transaction(async (transaction) => {
      const [organisation] = await transaction
        .insert(organisations)
        .values({
          xeroOrganisationId: `pending:${randomUUID()}`,
          name: input.name,
          timeZone: input.timeZone,
          baseCurrency: input.baseCurrency,
          edition: 'SOLO',
          sendMode: 'dry-run',
          rolloutScope: 'CONTROLLED',
          liveSendAcknowledged: false,
          operationalState: 'SYNC_REQUIRED'
        })
        .returning({ id: organisations.id });
      if (organisation === undefined) throw new Error('CUSTOMER_CREATE_FAILED');
      await transaction.insert(subscriptions).values({
        organisationId: organisation.id,
        planCode: 'SOLO_AU_2000',
        status: 'TRIALING',
        trialEndsAt: input.trialEndsAt
      });
      await transaction.insert(organisationOnboarding).values({
        organisationId: organisation.id,
        version: 1
      });
      await transaction.insert(smsAllowanceSettings).values({
        organisationId: organisation.id,
        includedParts: input.includedSmsParts,
        warningPercent: input.warningPercent,
        overageEnabled: false
      });
      const afterValue = {
        edition: 'SOLO',
        planCode: 'SOLO_AU_2000',
        sendMode: 'dry-run',
        rolloutScope: 'CONTROLLED',
        operationalState: 'SYNC_REQUIRED',
        trialEndsAt: input.trialEndsAt.toISOString(),
        includedSmsParts: input.includedSmsParts
      };
      await transaction.insert(auditEvents).values({
        organisationId: organisation.id,
        actorUserId: input.actorUserId,
        eventType: 'CUSTOMER_WORKSPACE_CREATED',
        entityType: 'ORGANISATION',
        entityId: organisation.id,
        afterValue,
        occurredAt: input.now
      });
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: input.actorUserId,
        targetOrganisationId: organisation.id,
        eventType: 'PLATFORM_CUSTOMER_CREATED',
        entityType: 'ORGANISATION',
        entityId: organisation.id,
        reason: input.reason,
        beforeValue: null,
        afterValue,
        occurredAt: input.now
      });
      return { organisationId: organisation.id };
    }),
  removeFailedWorkspace: async (organisationId) => {
    await database.transaction(async (transaction) => {
      await transaction
        .delete(platformAdminAuditEvents)
        .where(eq(platformAdminAuditEvents.targetOrganisationId, organisationId));
      await transaction
        .delete(organisations)
        .where(eq(organisations.id, organisationId));
    });
  }
});

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const allowedTimeZones = new Set<CreatePlatformCustomerInput['timeZone']>([
  'Australia/Sydney',
  'Australia/Adelaide',
  'Australia/Perth',
  'Pacific/Auckland'
]);

export const createPlatformCustomerProvisioningService = (dependencies: {
  verifyOwner(userId: string): Promise<boolean>;
  repository: PlatformCustomerProvisioningRepository;
  inviteMember: ReturnType<typeof getPlatformUserAdministration>['inviteMember'];
  clock: { now(): Date };
}) => ({
  async createCustomer(session: AppSession, raw: CreatePlatformCustomerInput) {
    if (!(await dependencies.verifyOwner(session.userId))) {
      throw new AuthorizationFailure();
    }
    const input = {
      ...raw,
      name: raw.name.trim(),
      adminEmail: raw.adminEmail.trim().toLowerCase(),
      adminDisplayName: raw.adminDisplayName.trim(),
      reason: raw.reason.trim()
    };
    if (
      input.name.length < 2 ||
      input.name.length > 160 ||
      !emailPattern.test(input.adminEmail) ||
      input.adminDisplayName.length < 2 ||
      input.adminDisplayName.length > 160 ||
      !allowedTimeZones.has(input.timeZone) ||
      !['AUD', 'NZD'].includes(input.baseCurrency) ||
      !Number.isSafeInteger(input.trialDays) ||
      input.trialDays < 1 ||
      input.trialDays > 90 ||
      !Number.isSafeInteger(input.includedSmsParts) ||
      input.includedSmsParts < 1 ||
      input.includedSmsParts > 1_000_000 ||
      !Number.isSafeInteger(input.warningPercent) ||
      input.warningPercent < 1 ||
      input.warningPercent > 100 ||
      input.reason.length < 3 ||
      input.reason.length > 500
    ) {
      throw new Error('VALIDATION');
    }
    const now = dependencies.clock.now();
    const workspace = await dependencies.repository.createWorkspace({
      actorUserId: session.userId,
      name: input.name,
      timeZone: input.timeZone,
      baseCurrency: input.baseCurrency,
      trialEndsAt: new Date(
        now.getTime() + input.trialDays * 24 * 60 * 60 * 1000
      ),
      includedSmsParts: input.includedSmsParts,
      warningPercent: input.warningPercent,
      reason: input.reason,
      now
    });
    try {
      const invitation = await dependencies.inviteMember(session, {
        organisationId: workspace.organisationId,
        email: input.adminEmail,
        displayName: input.adminDisplayName,
        role: 'ADMIN',
        reason: input.reason
      });
      return { organisationId: workspace.organisationId, ...invitation };
    } catch (error) {
      await dependencies.repository.removeFailedWorkspace(
        workspace.organisationId
      );
      throw error;
    }
  }
});

let service: ReturnType<typeof createPlatformCustomerProvisioningService> | undefined;

export const getPlatformCustomerProvisioningService = () => {
  service ??= createPlatformCustomerProvisioningService({
    verifyOwner: isPlatformOwner,
    repository: createPostgresPlatformCustomerProvisioningRepository(
      getDatabaseClient().db
    ),
    inviteMember: (...arguments_) =>
      getPlatformUserAdministration().inviteMember(...arguments_),
    clock: { now: () => new Date() }
  });
  return service;
};
