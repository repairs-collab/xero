import { randomUUID } from 'node:crypto';

import {
  and,
  eq,
  gt,
  isNull,
  lte,
  or,
  sql
} from 'drizzle-orm';

import type { Database, DbTransaction } from '../connection.js';
import { organisations } from '../schema/organisation.js';
import {
  xeroConnections,
  xeroOAuthTransactions,
  xeroPendingAuthorisations,
  type EncryptedRefreshTokenEnvelope,
  type XeroOAuthFlowPurpose,
  type XeroTenantCandidate
} from '../schema/xero.js';

type Executor = Database | DbTransaction;

export type XeroConnectionRecord = typeof xeroConnections.$inferSelect;
export type XeroOAuthTransactionRecord = typeof xeroOAuthTransactions.$inferSelect;
export type XeroPendingAuthorisationRecord =
  typeof xeroPendingAuthorisations.$inferSelect;

export interface CreateOAuthTransactionInput {
  stateHash: string;
  userId: string;
  existingOrganisationId: string | null;
  flowPurpose: XeroOAuthFlowPurpose;
  returnPath: string;
  expiresAt: Date;
}

export interface ConsumeOAuthTransactionInput {
  stateHash: string;
  userId: string;
  existingOrganisationId: string | null;
  now: Date;
}

export interface CreatePendingAuthorisationInput {
  userId: string;
  existingOrganisationId: string | null;
  flowPurpose: XeroOAuthFlowPurpose;
  encryptedRefreshToken: EncryptedRefreshTokenEnvelope;
  candidateTenants: XeroTenantCandidate[];
  grantedScopes: string[];
  expiresAt: Date;
}

export interface PendingAuthorisationLookup {
  pendingAuthorisationId: string;
  userId: string;
  existingOrganisationId: string | null;
  now: Date;
}

export interface FinalisePendingAuthorisationInput
  extends PendingAuthorisationLookup {
  organisationId: string;
  connectionId: string;
  tenantId: string;
}

export interface UpsertXeroConnectionInput {
  organisationId: string;
  connectionId: string;
  tenantId: string;
  encryptedRefreshToken: EncryptedRefreshTokenEnvelope;
  grantedScopes: string[];
  now: Date;
}

export interface AcquireRefreshLeaseInput {
  organisationId: string;
  leaseId: string;
  now: Date;
  expiresAt: Date;
}

export interface CompleteRefreshLeaseInput {
  organisationId: string;
  leaseId: string;
  encryptedRefreshToken: EncryptedRefreshTokenEnvelope;
  grantedScopes: string[];
  now: Date;
}

const organisationBinding = (
  executorValue: typeof xeroOAuthTransactions.existingOrganisationId,
  organisationId: string | null
) =>
  organisationId === null
    ? isNull(executorValue)
    : eq(executorValue, organisationId);

const pendingOrganisationBinding = (
  organisationId: string | null
) =>
  organisationId === null
    ? isNull(xeroPendingAuthorisations.existingOrganisationId)
    : eq(xeroPendingAuthorisations.existingOrganisationId, organisationId);

const postgresErrorCode = (error: unknown): string | null => {
  if (error === null || typeof error !== 'object') return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === 'string') return value.code;
  return postgresErrorCode(value.cause);
};

async function lockOrganisationForConnectionChange(
  transaction: DbTransaction,
  organisationId: string
): Promise<void> {
  // Xero email dispatch holds the organisation while refreshing in another
  // session. Acquire the organisation before any connection row locks.
  await transaction
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for('no key update');
}

async function clearOAuthSyncEvidence(
  transaction: DbTransaction,
  organisationId: string,
  now: Date
): Promise<void> {
  await transaction
    .update(organisations)
    .set({
      xeroSyncCursor: null,
      lastSuccessfulSyncAt: null,
      lastSuccessfulSyncId: null,
      lastSuccessfulXeroConnectionId: null,
      latestReconciledSyncAt: null,
      operationalState: sql`case
        when ${organisations.operationalState} in (
          'RESET_PREPARING',
          'RESET_IN_PROGRESS',
          'RESET_FAILED'
        ) then ${organisations.operationalState}
        else 'SYNC_REQUIRED'
      end`,
      operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`,
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: false,
      updatedAt: now
    })
    .where(eq(organisations.id, organisationId));
}

export class PostgresXeroConnectionRepository {
  constructor(private readonly database: Database) {}

  async createOAuthTransaction(
    input: CreateOAuthTransactionInput
  ): Promise<string> {
    const [created] = await this.database
      .insert(xeroOAuthTransactions)
      .values(input)
      .returning({ id: xeroOAuthTransactions.id });
    if (created === undefined) throw new Error('XERO_OAUTH_TRANSACTION_CREATE_FAILED');
    return created.id;
  }

  async consumeOAuthTransaction(
    input: ConsumeOAuthTransactionInput
  ): Promise<XeroOAuthTransactionRecord> {
    const [consumed] = await this.database
      .update(xeroOAuthTransactions)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(xeroOAuthTransactions.stateHash, input.stateHash),
          eq(xeroOAuthTransactions.userId, input.userId),
          organisationBinding(
            xeroOAuthTransactions.existingOrganisationId,
            input.existingOrganisationId
          ),
          isNull(xeroOAuthTransactions.consumedAt),
          gt(xeroOAuthTransactions.expiresAt, input.now)
        )
      )
      .returning();
    if (consumed === undefined) throw new Error('XERO_OAUTH_TRANSACTION_INVALID');
    return consumed;
  }

  async createPendingAuthorisation(
    input: CreatePendingAuthorisationInput
  ): Promise<string> {
    const [created] = await this.database
      .insert(xeroPendingAuthorisations)
      .values(input)
      .returning({ id: xeroPendingAuthorisations.id });
    if (created === undefined) throw new Error('XERO_PENDING_AUTHORISATION_CREATE_FAILED');
    return created.id;
  }

  async findPendingAuthorisation(
    input: PendingAuthorisationLookup
  ): Promise<XeroPendingAuthorisationRecord | null> {
    const [pending] = await this.database
      .select()
      .from(xeroPendingAuthorisations)
      .where(this.pendingLookupWhere(input))
      .limit(1);
    return pending ?? null;
  }

  async finalisePendingAuthorisation(
    input: FinalisePendingAuthorisationInput
  ): Promise<XeroConnectionRecord> {
    try {
      return await this.database.transaction(async (transaction) => {
      await lockOrganisationForConnectionChange(transaction, input.organisationId);
      const [existingForOrganisation] = await transaction
        .select()
        .from(xeroConnections)
        .where(eq(xeroConnections.organisationId, input.organisationId))
        .for('update')
        .limit(1);

      const [pending] = await transaction
        .select()
        .from(xeroPendingAuthorisations)
        .where(this.pendingLookupWhere(input))
        .for('update')
        .limit(1);

      if (pending === undefined) {
        if (
          existingForOrganisation !== undefined &&
          existingForOrganisation.connectionId === input.connectionId &&
          existingForOrganisation.tenantId === input.tenantId &&
          existingForOrganisation.status !== 'DISCONNECTED'
        ) {
          return existingForOrganisation;
        }
        throw new Error('XERO_PENDING_AUTHORISATION_INVALID');
      }

      const candidate = pending.candidateTenants.find(
        (value) =>
          value.connectionId === input.connectionId &&
          value.tenantId === input.tenantId
      );
      if (candidate === undefined) throw new Error('XERO_TENANT_NOT_AUTHORISED');

      if (
        candidate.xeroOrganisationId !== undefined &&
        candidate.organisationName !== undefined &&
        candidate.baseCurrency !== undefined &&
        candidate.timeZone !== undefined
      ) {
        await transaction
          .update(organisations)
          .set({
            xeroOrganisationId: candidate.xeroOrganisationId,
            name: candidate.organisationName,
            baseCurrency: candidate.baseCurrency.toUpperCase(),
            timeZone: candidate.timeZone,
            updatedAt: input.now
          })
          .where(eq(organisations.id, input.organisationId));
      }

      const [existingOwner] = await transaction
        .select()
        .from(xeroConnections)
        .where(
          or(
            eq(xeroConnections.connectionId, input.connectionId),
            eq(xeroConnections.tenantId, input.tenantId)
          )
        )
        .for('update')
        .limit(1);
      if (
        existingOwner !== undefined &&
        existingOwner.organisationId !== input.organisationId
      ) {
        throw new Error('XERO_TENANT_ALREADY_CONNECTED');
      }

      let connection: XeroConnectionRecord;
      if (existingForOrganisation === undefined) {
        const [inserted] = await transaction
          .insert(xeroConnections)
          .values({
            organisationId: input.organisationId,
            connectionId: input.connectionId,
            tenantId: input.tenantId,
            encryptedRefreshToken: pending.encryptedRefreshToken,
            grantedScopes: pending.grantedScopes,
            connectedAt: input.now,
            updatedAt: input.now
          })
          .returning();
        if (inserted === undefined) throw new Error('XERO_CONNECTION_CREATE_FAILED');
        connection = inserted;
      } else {
        if (
          existingForOrganisation.connectionId !== input.connectionId ||
          existingForOrganisation.tenantId !== input.tenantId
        ) {
          throw new Error('XERO_ORGANISATION_ALREADY_CONNECTED');
        }
        const [updated] = await transaction
          .update(xeroConnections)
          .set({
            id: randomUUID(),
            status: 'CONNECTED',
            encryptedRefreshToken: pending.encryptedRefreshToken,
            grantedScopes: pending.grantedScopes,
            refreshTokenVersion: sql`${xeroConnections.refreshTokenVersion} + 1`,
            refreshLeaseId: null,
            refreshLeaseExpiresAt: null,
            connectedAt: input.now,
            disconnectedAt: null,
            updatedAt: input.now
          })
          .where(eq(xeroConnections.id, existingForOrganisation.id))
          .returning();
        if (updated === undefined) throw new Error('XERO_CONNECTION_UPDATE_FAILED');
        connection = updated;
      }

      await clearOAuthSyncEvidence(
        transaction,
        input.organisationId,
        input.now
      );
      await transaction
        .delete(xeroPendingAuthorisations)
        .where(eq(xeroPendingAuthorisations.id, pending.id));
        return connection;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new Error('XERO_TENANT_ALREADY_CONNECTED');
      }
      throw error;
    }
  }

  async upsertConnection(
    input: UpsertXeroConnectionInput
  ): Promise<XeroConnectionRecord> {
    try {
      return await this.database.transaction(async (transaction) => {
      await lockOrganisationForConnectionChange(transaction, input.organisationId);
      const [ownedElsewhere] = await transaction
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
      if (
        ownedElsewhere !== undefined &&
        ownedElsewhere.organisationId !== input.organisationId
      ) {
        throw new Error('XERO_TENANT_ALREADY_CONNECTED');
      }

      const [existing] = await transaction
        .select()
        .from(xeroConnections)
        .where(eq(xeroConnections.organisationId, input.organisationId))
        .for('update')
        .limit(1);
      if (existing === undefined) {
        const [inserted] = await transaction
          .insert(xeroConnections)
          .values({
            organisationId: input.organisationId,
            connectionId: input.connectionId,
            tenantId: input.tenantId,
            status: 'CONNECTED',
            encryptedRefreshToken: input.encryptedRefreshToken,
            grantedScopes: input.grantedScopes,
            connectedAt: input.now,
            updatedAt: input.now
          })
          .returning();
        if (inserted === undefined) throw new Error('XERO_CONNECTION_CREATE_FAILED');
        await clearOAuthSyncEvidence(
          transaction,
          input.organisationId,
          input.now
        );
        return inserted;
      }
      if (
        existing.connectionId !== input.connectionId ||
        existing.tenantId !== input.tenantId
      ) {
        throw new Error('XERO_ORGANISATION_ALREADY_CONNECTED');
      }

      const [updated] = await transaction
        .update(xeroConnections)
        .set({
          id: randomUUID(),
          status: 'CONNECTED',
          encryptedRefreshToken: input.encryptedRefreshToken,
          grantedScopes: input.grantedScopes,
          refreshTokenVersion: sql`${xeroConnections.refreshTokenVersion} + 1`,
          refreshLeaseId: null,
          refreshLeaseExpiresAt: null,
          connectedAt: input.now,
          disconnectedAt: null,
          updatedAt: input.now
        })
        .where(eq(xeroConnections.id, existing.id))
        .returning();
      if (updated === undefined) throw new Error('XERO_CONNECTION_UPDATE_FAILED');
        await clearOAuthSyncEvidence(
          transaction,
          input.organisationId,
          input.now
        );
        return updated;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new Error('XERO_TENANT_ALREADY_CONNECTED');
      }
      throw error;
    }
  }

  async findByOrganisationId(
    organisationId: string
  ): Promise<XeroConnectionRecord | null> {
    return this.findConnection(
      this.database,
      eq(xeroConnections.organisationId, organisationId)
    );
  }

  async findOrganisationIdByTenantId(tenantId: string): Promise<string | null> {
    const [connection] = await this.database
      .select({ organisationId: xeroConnections.organisationId })
      .from(xeroConnections)
      .where(eq(xeroConnections.tenantId, tenantId))
      .limit(1);
    return connection?.organisationId ?? null;
  }

  async markReauthRequired(
    organisationId: string,
    now: Date
  ): Promise<XeroConnectionRecord> {
    const [updated] = await this.database
      .update(xeroConnections)
      .set({
        status: 'REAUTH_REQUIRED',
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        updatedAt: now
      })
      .where(
        and(
          eq(xeroConnections.organisationId, organisationId),
          eq(xeroConnections.status, 'CONNECTED')
        )
      )
      .returning();
    if (updated === undefined) throw new Error('XERO_CONNECTION_NOT_CONNECTED');
    return updated;
  }

  async disconnect(
    organisationId: string,
    now: Date
  ): Promise<XeroConnectionRecord> {
    const [updated] = await this.database
      .update(xeroConnections)
      .set({
        status: 'DISCONNECTED',
        encryptedRefreshToken: null,
        grantedScopes: [],
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        disconnectedAt: now,
        updatedAt: now
      })
      .where(eq(xeroConnections.organisationId, organisationId))
      .returning();
    if (updated === undefined) throw new Error('XERO_CONNECTION_NOT_FOUND');
    return updated;
  }

  async acquireRefreshLease(
    input: AcquireRefreshLeaseInput
  ): Promise<XeroConnectionRecord | null> {
    const [updated] = await this.database
      .update(xeroConnections)
      .set({
        refreshLeaseId: input.leaseId,
        refreshLeaseExpiresAt: input.expiresAt,
        updatedAt: input.now
      })
      .where(
        and(
          eq(xeroConnections.organisationId, input.organisationId),
          eq(xeroConnections.status, 'CONNECTED'),
          or(
            isNull(xeroConnections.refreshLeaseId),
            lte(xeroConnections.refreshLeaseExpiresAt, input.now)
          )
        )
      )
      .returning();
    return updated ?? null;
  }

  async completeRefreshLease(
    input: CompleteRefreshLeaseInput
  ): Promise<XeroConnectionRecord> {
    const [updated] = await this.database
      .update(xeroConnections)
      .set({
        encryptedRefreshToken: input.encryptedRefreshToken,
        grantedScopes: input.grantedScopes,
        refreshTokenVersion: sql`${xeroConnections.refreshTokenVersion} + 1`,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        lastRefreshedAt: input.now,
        updatedAt: input.now
      })
      .where(
        and(
          eq(xeroConnections.organisationId, input.organisationId),
          eq(xeroConnections.status, 'CONNECTED'),
          eq(xeroConnections.refreshLeaseId, input.leaseId)
        )
      )
      .returning();
    if (updated === undefined) throw new Error('XERO_REFRESH_LEASE_NOT_OWNED');
    return updated;
  }

  async releaseRefreshLease(
    organisationId: string,
    leaseId: string,
    now: Date
  ): Promise<boolean> {
    const [released] = await this.database
      .update(xeroConnections)
      .set({
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        updatedAt: now
      })
      .where(
        and(
          eq(xeroConnections.organisationId, organisationId),
          eq(xeroConnections.refreshLeaseId, leaseId)
        )
      )
      .returning({ id: xeroConnections.id });
    return released !== undefined;
  }

  private pendingLookupWhere(input: PendingAuthorisationLookup) {
    return and(
      eq(xeroPendingAuthorisations.id, input.pendingAuthorisationId),
      eq(xeroPendingAuthorisations.userId, input.userId),
      pendingOrganisationBinding(input.existingOrganisationId),
      isNull(xeroPendingAuthorisations.consumedAt),
      gt(xeroPendingAuthorisations.expiresAt, input.now)
    );
  }

  private async findConnection(
    executor: Executor,
    where: ReturnType<typeof eq>
  ): Promise<XeroConnectionRecord | null> {
    const [connection] = await executor
      .select()
      .from(xeroConnections)
      .where(where)
      .limit(1);
    return connection ?? null;
  }
}
