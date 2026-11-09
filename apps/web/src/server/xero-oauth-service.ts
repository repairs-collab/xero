import { createHash, randomBytes } from 'node:crypto';

import { authorise, type AppSession } from '@bc5000/auth';
import type {
  EncryptedRefreshTokenEnvelope,
  XeroConnectionStatus,
  XeroOAuthFlowPurpose,
  XeroTenantCandidate
} from '@bc5000/db/web';
import type {
  TokenCipher,
  XeroAuthorisedSession,
  XeroOAuthConnection,
  XeroOAuthTokens,
  XeroOrganisation
} from '@bc5000/integrations/xero';

import { accountPulseTimeZoneForXero } from './solo-provisioning-service.js';

export interface XeroConnectionForOAuth {
  organisationId: string;
  connectionId: string;
  tenantId: string;
  status: XeroConnectionStatus;
  encryptedRefreshToken: EncryptedRefreshTokenEnvelope | null;
  grantedScopes: string[];
  refreshTokenVersion: number;
  refreshLeaseId: string | null;
  refreshLeaseExpiresAt: Date | null;
}

export interface XeroOAuthRepository {
  createOAuthTransaction(input: {
    stateHash: string;
    userId: string;
    existingOrganisationId: string | null;
    flowPurpose: XeroOAuthFlowPurpose;
    returnPath: string;
    expiresAt: Date;
  }): Promise<string>;
  consumeOAuthTransaction(input: {
    stateHash: string;
    userId: string;
    existingOrganisationId: string | null;
    now: Date;
  }): Promise<{
    flowPurpose: XeroOAuthFlowPurpose;
    existingOrganisationId: string | null;
    returnPath: string;
  }>;
  createPendingAuthorisation(input: {
    userId: string;
    existingOrganisationId: string | null;
    flowPurpose: XeroOAuthFlowPurpose;
    encryptedRefreshToken: EncryptedRefreshTokenEnvelope;
    candidateTenants: XeroTenantCandidate[];
    grantedScopes: string[];
    expiresAt: Date;
  }): Promise<string>;
  findPendingAuthorisation(input: {
    pendingAuthorisationId: string;
    userId: string;
    existingOrganisationId: string | null;
    now: Date;
  }): Promise<{
    candidateTenants: XeroTenantCandidate[];
    encryptedRefreshToken: EncryptedRefreshTokenEnvelope;
  } | null>;
  finalisePendingAuthorisation(input: {
    pendingAuthorisationId: string;
    userId: string;
    existingOrganisationId: string | null;
    organisationId: string;
    connectionId: string;
    tenantId: string;
    now: Date;
  }): Promise<XeroConnectionForOAuth>;
  findByOrganisationId(
    organisationId: string
  ): Promise<XeroConnectionForOAuth | null>;
  disconnect(
    organisationId: string,
    now: Date
  ): Promise<XeroConnectionForOAuth>;
}

export interface XeroOAuthProtocol {
  createAuthorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<XeroOAuthTokens>;
  listConnections(accessToken: string): Promise<XeroOAuthConnection[]>;
  deleteConnection(accessToken: string, connectionId: string): Promise<void>;
}

export type XeroOAuthAuditEventType =
  | 'XERO_CONNECTED'
  | 'XERO_RECONNECTED'
  | 'XERO_TENANT_SELECTED'
  | 'XERO_DISCONNECTED'
  | 'XERO_TENANT_CONFLICT_REJECTED';

export interface XeroOAuthAuditEvent {
  organisationId: string;
  actorUserId: string;
  eventType: XeroOAuthAuditEventType;
  entityId: string;
  afterValue: Record<string, unknown>;
  occurredAt: Date;
}

export interface XeroOAuthServiceDependencies {
  repository: XeroOAuthRepository;
  tokenCipher: TokenCipher;
  oauth: XeroOAuthProtocol;
  sessionForOrganisation(
    organisationId: string
  ): Promise<XeroAuthorisedSession>;
  audit(event: XeroOAuthAuditEvent): Promise<void>;
  organisationForTenant?(
    accessToken: string,
    tenantId: string
  ): Promise<XeroOrganisation>;
  provisionSolo?(
    session: AppSession,
    input: {
      pendingAuthorisationId: string;
      connectionId: string;
      tenantId: string;
    }
  ): Promise<{
    organisationId: string;
    created: boolean;
    initialSyncQueued: boolean;
  }>;
  findSoloOrganisation?(userId: string): Promise<string | null>;
  clock: { now(): Date };
  randomState?: () => string;
}

interface StatePayload {
  version: 1;
  nonce: string;
  userBinding: string;
  flowPurpose: XeroOAuthFlowPurpose;
  existingOrganisationId: string | null;
}

const hashState = (state: string): string =>
  createHash('sha256').update(state, 'utf8').digest('hex');

const encodeState = (payload: StatePayload): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const decodeState = (state: string): StatePayload => {
  try {
    const value = JSON.parse(
      Buffer.from(state, 'base64url').toString('utf8')
    ) as Partial<StatePayload>;
    if (
      value.version !== 1 ||
      typeof value.nonce !== 'string' ||
      value.nonce.length < 16 ||
      typeof value.userBinding !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.userBinding) ||
      (value.flowPurpose !== 'NEW_SOLO' &&
        value.flowPurpose !== 'CONNECT_EXISTING') ||
      (value.existingOrganisationId !== null &&
        typeof value.existingOrganisationId !== 'string') ||
      (value.flowPurpose === 'CONNECT_EXISTING' &&
        value.existingOrganisationId === null) ||
      (value.flowPurpose === 'NEW_SOLO' &&
        value.existingOrganisationId !== null)
    ) {
      throw new Error('invalid state');
    }
    return value as StatePayload;
  } catch {
    throw new Error('XERO_OAUTH_STATE_INVALID');
  }
};

const safeReturnPath = (value: string): string =>
  value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/settings/integrations';

const bindStateToUser = (nonce: string, userId: string): string =>
  createHash('sha256').update(`${nonce}:${userId}`, 'utf8').digest('hex');

const tenantCandidates = (
  connections: XeroOAuthConnection[]
): XeroTenantCandidate[] =>
  connections.map((connection) => ({
    connectionId: connection.id,
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    tenantType: connection.tenantType
  }));

export const createXeroOAuthService = (
  dependencies: XeroOAuthServiceDependencies
) => {
  const randomState =
    dependencies.randomState ?? (() => randomBytes(32).toString('base64url'));

  const auditConnection = async (
    session: AppSession,
    connection: XeroConnectionForOAuth,
    previous: XeroConnectionForOAuth | null,
    now: Date
  ): Promise<void> => {
    await dependencies.audit({
      organisationId: connection.organisationId,
      actorUserId: session.userId,
      eventType:
        previous === null || previous.status === 'DISCONNECTED'
          ? previous === null
            ? 'XERO_CONNECTED'
            : 'XERO_RECONNECTED'
          : 'XERO_RECONNECTED',
      entityId: connection.connectionId,
      afterValue: {
        tenantId: connection.tenantId,
        status: connection.status,
        refreshTokenVersion: connection.refreshTokenVersion
      },
      occurredAt: now
    });
  };

  const startConnection = async (
    session: AppSession,
    input: { organisationId: string; returnPath: string }
  ): Promise<{ authorizationUrl: string }> => {
    authorise(session, 'provider.configure', input.organisationId);
    const nonce = randomState();
    const state = encodeState({
      version: 1,
      nonce,
      userBinding: bindStateToUser(nonce, session.userId),
      flowPurpose: 'CONNECT_EXISTING',
      existingOrganisationId: input.organisationId
    });
    await dependencies.repository.createOAuthTransaction({
      stateHash: hashState(state),
      userId: session.userId,
      existingOrganisationId: input.organisationId,
      flowPurpose: 'CONNECT_EXISTING',
      returnPath: safeReturnPath(input.returnPath),
      expiresAt: new Date(dependencies.clock.now().getTime() + 10 * 60_000)
    });
    return { authorizationUrl: dependencies.oauth.createAuthorizationUrl(state) };
  };

  const startSoloConnection = async (
    session: AppSession
  ): Promise<{ authorizationUrl: string }> => {
    if (session.memberships.some((membership) => membership.active)) {
      throw new Error('XERO_SOLO_ACCOUNT_EXISTS');
    }
    const nonce = randomState();
    const state = encodeState({
      version: 1,
      nonce,
      userBinding: bindStateToUser(nonce, session.userId),
      flowPurpose: 'NEW_SOLO',
      existingOrganisationId: null
    });
    await dependencies.repository.createOAuthTransaction({
      stateHash: hashState(state),
      userId: session.userId,
      existingOrganisationId: null,
      flowPurpose: 'NEW_SOLO',
      returnPath: '/onboarding',
      expiresAt: new Date(dependencies.clock.now().getTime() + 10 * 60_000)
    });
    return { authorizationUrl: dependencies.oauth.createAuthorizationUrl(state) };
  };

  const handleCallback = async (
    session: AppSession,
    input: { state: string; code: string | null; error: string | null }
  ): Promise<
    | { kind: 'CONNECTED'; organisationId: string; returnPath: string }
    | {
        kind: 'SELECT_TENANT';
        organisationId: string;
        pendingAuthorisationId: string;
      }
    | {
        kind: 'SELECT_SOLO_TENANT';
        pendingAuthorisationId: string;
      }
  > => {
    const state = decodeState(input.state);
    if (state.userBinding !== bindStateToUser(state.nonce, session.userId)) {
      throw new Error('XERO_OAUTH_STATE_INVALID');
    }
    const organisationId = state.existingOrganisationId;
    if (organisationId === null) {
      if (session.memberships.some((membership) => membership.active)) {
        throw new Error('XERO_SOLO_ACCOUNT_EXISTS');
      }
    } else {
      authorise(session, 'provider.configure', organisationId);
    }
    const now = dependencies.clock.now();
    let transaction: Awaited<
      ReturnType<XeroOAuthRepository['consumeOAuthTransaction']>
    >;
    try {
      transaction = await dependencies.repository.consumeOAuthTransaction({
        stateHash: hashState(input.state),
        userId: session.userId,
        existingOrganisationId: organisationId,
        now
      });
    } catch (error) {
      if (organisationId !== null) {
        const existing = await dependencies.repository.findByOrganisationId(
          organisationId
        );
        if (existing !== null && existing.status !== 'DISCONNECTED') {
          return {
            kind: 'CONNECTED',
            organisationId,
            returnPath: '/settings/integrations'
          };
        }
      } else if (dependencies.findSoloOrganisation !== undefined) {
        const existing = await dependencies.findSoloOrganisation(session.userId);
        if (existing !== null) {
          return {
            kind: 'CONNECTED',
            organisationId: existing,
            returnPath: '/onboarding'
          };
        }
      }
      throw error;
    }
    if (input.error !== null) throw new Error('XERO_CONSENT_DENIED');
    if (input.code === null || input.code.length === 0) {
      throw new Error('XERO_AUTHORIZATION_CODE_REQUIRED');
    }

    const tokens = await dependencies.oauth.exchangeAuthorizationCode(input.code);
    const connections = await dependencies.oauth.listConnections(tokens.accessToken);
    if (connections.length === 0) throw new Error('XERO_NO_TENANTS');
    const encryptedRefreshToken = dependencies.tokenCipher.encrypt(
      tokens.refreshToken
    );
    let candidates = tenantCandidates(connections);
    if (transaction.flowPurpose === 'NEW_SOLO') {
      if (
        dependencies.organisationForTenant === undefined ||
        dependencies.provisionSolo === undefined
      ) {
        throw new Error('XERO_SOLO_PROVISIONING_NOT_CONFIGURED');
      }
      candidates = await Promise.all(
        connections.map(async (connection) => {
          const organisation = await dependencies.organisationForTenant?.(
            tokens.accessToken,
            connection.tenantId
          );
          if (organisation === undefined) {
            throw new Error('XERO_SOLO_PROVISIONING_NOT_CONFIGURED');
          }
          return {
            ...tenantCandidates([connection])[0]!,
            xeroOrganisationId: organisation.id,
            organisationName: organisation.name,
            baseCurrency: organisation.baseCurrency,
            timeZone: accountPulseTimeZoneForXero(organisation.timeZone)
          };
        })
      );
    }
    const pendingAuthorisationId =
      await dependencies.repository.createPendingAuthorisation({
        userId: session.userId,
        existingOrganisationId: organisationId,
        flowPurpose: transaction.flowPurpose,
        encryptedRefreshToken,
        candidateTenants: candidates,
        grantedScopes: tokens.scopes,
        expiresAt: new Date(now.getTime() + 5 * 60_000)
      });

    if (connections.length > 1) {
      if (transaction.flowPurpose === 'NEW_SOLO') {
        return {
          kind: 'SELECT_SOLO_TENANT',
          pendingAuthorisationId
        };
      }
      if (organisationId === null) throw new Error('XERO_OAUTH_STATE_INVALID');
      return {
        kind: 'SELECT_TENANT',
        organisationId,
        pendingAuthorisationId
      };
    }

    const selected = connections[0];
    if (selected === undefined) throw new Error('XERO_NO_TENANTS');
    if (transaction.flowPurpose === 'NEW_SOLO') {
      if (dependencies.provisionSolo === undefined) {
        throw new Error('XERO_SOLO_PROVISIONING_NOT_CONFIGURED');
      }
      const provisioned = await dependencies.provisionSolo(session, {
        pendingAuthorisationId,
        connectionId: selected.id,
        tenantId: selected.tenantId
      });
      return {
        kind: 'CONNECTED',
        organisationId: provisioned.organisationId,
        returnPath: provisioned.initialSyncQueued
          ? '/onboarding?sync=queued'
          : '/onboarding?sync=retry'
      };
    }
    if (organisationId === null) throw new Error('XERO_OAUTH_STATE_INVALID');
    const previous = await dependencies.repository.findByOrganisationId(
      organisationId
    );
    const connection =
      await dependencies.repository.finalisePendingAuthorisation({
        pendingAuthorisationId,
        userId: session.userId,
        existingOrganisationId: organisationId,
        organisationId,
        connectionId: selected.id,
        tenantId: selected.tenantId,
        now
      });
    await dependencies.audit({
      organisationId,
      actorUserId: session.userId,
      eventType: 'XERO_TENANT_SELECTED',
      entityId: selected.id,
      afterValue: { tenantId: selected.tenantId, automatic: true },
      occurredAt: now
    });
    await auditConnection(session, connection, previous, now);
    return {
      kind: 'CONNECTED',
      organisationId,
      returnPath: transaction.returnPath
    };
  };

  const getTenantSelection = async (
    session: AppSession,
    input: { organisationId: string; pendingAuthorisationId: string }
  ): Promise<{
    candidates: Array<{
      connectionId: string;
      tenantId: string;
      tenantName: string;
      tenantType: string | null;
    }>;
  }> => {
    authorise(session, 'provider.configure', input.organisationId);
    const pending = await dependencies.repository.findPendingAuthorisation({
      pendingAuthorisationId: input.pendingAuthorisationId,
      userId: session.userId,
      existingOrganisationId: input.organisationId,
      now: dependencies.clock.now()
    });
    if (pending === null) throw new Error('XERO_PENDING_AUTHORISATION_INVALID');
    return {
      candidates: pending.candidateTenants.map((candidate) => ({
        connectionId: candidate.connectionId,
        tenantId: candidate.tenantId,
        tenantName: candidate.tenantName,
        tenantType: candidate.tenantType ?? null
      }))
    };
  };

  const selectTenant = async (
    session: AppSession,
    input: {
      organisationId: string;
      pendingAuthorisationId: string;
      connectionId: string;
      tenantId: string;
    }
  ): Promise<XeroConnectionForOAuth> => {
    authorise(session, 'provider.configure', input.organisationId);
    const now = dependencies.clock.now();
    const previous = await dependencies.repository.findByOrganisationId(
      input.organisationId
    );
    try {
      const connection =
        await dependencies.repository.finalisePendingAuthorisation({
          ...input,
          userId: session.userId,
          existingOrganisationId: input.organisationId,
          now
        });
      await dependencies.audit({
        organisationId: input.organisationId,
        actorUserId: session.userId,
        eventType: 'XERO_TENANT_SELECTED',
        entityId: input.connectionId,
        afterValue: { tenantId: input.tenantId, automatic: false },
        occurredAt: now
      });
      await auditConnection(session, connection, previous, now);
      return connection;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'XERO_TENANT_ALREADY_CONNECTED'
      ) {
        await dependencies.audit({
          organisationId: input.organisationId,
          actorUserId: session.userId,
          eventType: 'XERO_TENANT_CONFLICT_REJECTED',
          entityId: input.connectionId,
          afterValue: { tenantId: input.tenantId },
          occurredAt: now
        });
      }
      throw error;
    }
  };

  const getSoloTenantSelection = async (
    session: AppSession,
    pendingAuthorisationId: string
  ) => {
    if (session.memberships.some((membership) => membership.active)) {
      throw new Error('XERO_SOLO_ACCOUNT_EXISTS');
    }
    const pending = await dependencies.repository.findPendingAuthorisation({
      pendingAuthorisationId,
      userId: session.userId,
      existingOrganisationId: null,
      now: dependencies.clock.now()
    });
    if (pending === null) throw new Error('XERO_PENDING_AUTHORISATION_INVALID');
    return {
      candidates: pending.candidateTenants.map((candidate) => ({
        connectionId: candidate.connectionId,
        tenantId: candidate.tenantId,
        tenantName: candidate.organisationName ?? candidate.tenantName
      }))
    };
  };

  const selectSoloTenant = async (
    session: AppSession,
    input: {
      pendingAuthorisationId: string;
      connectionId: string;
      tenantId: string;
    }
  ) => {
    if (dependencies.provisionSolo === undefined) {
      throw new Error('XERO_SOLO_PROVISIONING_NOT_CONFIGURED');
    }
    await getSoloTenantSelection(session, input.pendingAuthorisationId);
    return dependencies.provisionSolo(session, input);
  };

  const disconnect = async (
    session: AppSession,
    organisationId: string
  ): Promise<void> => {
    authorise(session, 'provider.configure', organisationId);
    const existing = await dependencies.repository.findByOrganisationId(
      organisationId
    );
    if (existing === null || existing.status === 'DISCONNECTED') return;
    const authorised = await dependencies.sessionForOrganisation(organisationId);
    await dependencies.oauth.deleteConnection(
      authorised.accessToken,
      existing.connectionId
    );
    const now = dependencies.clock.now();
    await dependencies.repository.disconnect(organisationId, now);
    await dependencies.audit({
      organisationId,
      actorUserId: session.userId,
      eventType: 'XERO_DISCONNECTED',
      entityId: existing.connectionId,
      afterValue: { tenantId: existing.tenantId, status: 'DISCONNECTED' },
      occurredAt: now
    });
  };

  return {
    startConnection,
    startSoloConnection,
    handleCallback,
    getTenantSelection,
    selectTenant,
    getSoloTenantSelection,
    selectSoloTenant,
    disconnect
  };
};
