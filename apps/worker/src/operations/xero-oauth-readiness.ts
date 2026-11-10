import { and, eq, gt, sql } from 'drizzle-orm';

import {
  type Database,
  invoices,
  organisations,
  providerConnections,
  xeroConnections,
  type OperationalState,
  type RolloutScope,
  type XeroConnectionStatus
} from '@bc5000/db';
import { requiredXeroOAuthScopes } from '@bc5000/integrations/xero';

export interface XeroOAuthReadinessSnapshot {
  organisationId: string;
  xeroOrganisationId: string;
  organisationName: string;
  sendMode: 'dry-run' | 'live';
  rolloutScope: RolloutScope;
  liveSendAcknowledged: boolean;
  legacyConnectionPresent: boolean;
  legacyConnectionEnabled: boolean;
  oauthConnectionStatus: XeroConnectionStatus | null;
  oauthTenantId: string | null;
  grantedScopes: string[];
  lastSuccessfulSyncAt: Date | null;
  operationalState: OperationalState;
  latestReconciledSyncAt: Date | null;
  outstandingInvoiceCount: number;
  outstandingAmountDue: string;
}

export interface XeroOAuthReadinessLoader {
  load(organisationId: string): Promise<XeroOAuthReadinessSnapshot>;
}

export const parseXeroOAuthReadinessCommand = (
  arguments_: string[]
): { organisationId: string } | null => {
  if (arguments_.length === 0) return null;
  if (arguments_[0] !== 'xero-oauth-readiness') {
    throw new Error('Unsupported worker command');
  }
  if (
    arguments_.length !== 3 ||
    arguments_[1] !== '--organisation-id'
  ) {
    if (arguments_.includes('--organisation-id')) {
      throw new Error('Unsupported Xero OAuth readiness flag');
    }
    throw new Error('organisation-id is required');
  }
  const organisationId = arguments_[2]?.trim();
  if (!organisationId) throw new Error('organisation-id is required');
  return { organisationId };
};

export const createXeroOAuthReadinessService = (
  dependencies: XeroOAuthReadinessLoader
) => ({
  run: async (organisationId: string) => {
    const snapshot = await dependencies.load(organisationId);
    const missingScopes = requiredXeroOAuthScopes.filter(
      (scope) => !snapshot.grantedScopes.includes(scope)
    );
    const tenantMatchesOrganisation =
      snapshot.oauthTenantId !== null &&
      snapshot.oauthTenantId === snapshot.xeroOrganisationId;
    const reconciliationCurrent =
      snapshot.lastSuccessfulSyncAt !== null &&
      snapshot.latestReconciledSyncAt !== null &&
      snapshot.latestReconciledSyncAt.getTime() >=
        snapshot.lastSuccessfulSyncAt.getTime();
    return {
      organisationId: snapshot.organisationId,
      organisationName: snapshot.organisationName,
      legacy: {
        present: snapshot.legacyConnectionPresent,
        enabled: snapshot.legacyConnectionEnabled
      },
      oauth: {
        status: snapshot.oauthConnectionStatus,
        tenantId: snapshot.oauthTenantId,
        tenantMatchesOrganisation,
        grantedScopes: [...snapshot.grantedScopes],
        missingScopes
      },
      synchronisation: {
        lastSuccessfulSyncAt:
          snapshot.lastSuccessfulSyncAt?.toISOString() ?? null,
        operationalState: snapshot.operationalState,
        latestReconciledSyncAt:
          snapshot.latestReconciledSyncAt?.toISOString() ?? null,
        reconciliationCurrent,
        outstandingInvoiceCount: snapshot.outstandingInvoiceCount,
        outstandingAmountDue: snapshot.outstandingAmountDue
      },
      sendingSafeguards: {
        sendMode: snapshot.sendMode,
        rolloutScope: snapshot.rolloutScope,
        liveSendAcknowledged: snapshot.liveSendAcknowledged,
        unchanged: true
      },
      readyForApprovedCutover:
        snapshot.legacyConnectionPresent &&
        snapshot.legacyConnectionEnabled &&
        snapshot.oauthConnectionStatus === 'CONNECTED' &&
        tenantMatchesOrganisation &&
        missingScopes.length === 0 &&
        snapshot.operationalState === 'RECONCILED' &&
        reconciliationCurrent
    };
  }
});

export const createDatabaseXeroOAuthReadinessLoader = (
  database: Database
): XeroOAuthReadinessLoader => ({
  load: async (organisationId) => {
    const [organisation] = await database
      .select()
      .from(organisations)
      .where(eq(organisations.id, organisationId))
      .limit(1);
    if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
    const [legacy] = await database
      .select({ enabled: providerConnections.enabled })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.organisationId, organisationId),
          eq(providerConnections.provider, 'XERO')
        )
      )
      .limit(1);
    const [oauth] = await database
      .select({
        status: xeroConnections.status,
        tenantId: xeroConnections.tenantId,
        grantedScopes: xeroConnections.grantedScopes
      })
      .from(xeroConnections)
      .where(eq(xeroConnections.organisationId, organisationId))
      .limit(1);
    const [totals] = await database
      .select({
        count: sql<number>`count(*)::int`,
        amountDue: sql<string>`coalesce(sum(${invoices.amountDue}), 0)::text`
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, organisationId),
          eq(invoices.type, 'ACCREC'),
          eq(invoices.status, 'AUTHORISED'),
          gt(invoices.amountDue, '0')
        )
      );
    return {
      organisationId,
      xeroOrganisationId: organisation.xeroOrganisationId,
      organisationName: organisation.name,
      sendMode: organisation.sendMode,
      rolloutScope: organisation.rolloutScope,
      liveSendAcknowledged: organisation.liveSendAcknowledged,
      legacyConnectionPresent: legacy !== undefined,
      legacyConnectionEnabled: legacy?.enabled ?? false,
      oauthConnectionStatus: oauth?.status ?? null,
      oauthTenantId: oauth?.tenantId ?? null,
      grantedScopes: oauth?.grantedScopes ?? [],
      lastSuccessfulSyncAt: organisation.lastSuccessfulSyncAt,
      operationalState: organisation.operationalState,
      latestReconciledSyncAt: organisation.latestReconciledSyncAt,
      outstandingInvoiceCount: totals?.count ?? 0,
      outstandingAmountDue: totals?.amountDue ?? '0'
    };
  }
});
