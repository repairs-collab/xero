import { and, count, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { outboundMessages } from '../schema/messaging.js';
import { pauses, tasks } from '../schema/operations.js';
import { organisations, providerConnections, type OrganisationEdition } from '../schema/organisation.js';
import { invoices } from '../schema/receivables.js';
import { approvals, invoiceChases, stageInstances } from '../schema/reminders.js';
import { xeroConnections, type XeroConnectionStatus } from '../schema/xero.js';

export interface DashboardSnapshot {
  overdueTotal: string;
  overdueCount: number;
  awaitingApproval: number;
  pausedCustomers: number;
  openEscalations: number;
  paidAfterReminders: string;
  lastXeroSync: Date | null;
  xeroOAuthStatus: XeroConnectionStatus | null;
  legacyXeroEnabled: boolean;
  edition: OrganisationEdition;
  baseCurrency: string;
  timeZone: string;
  messagingHealthy: boolean;
}

export class DashboardRepository {
  constructor(private readonly database: Database) {}

  async snapshot(organisationId: string, today: string): Promise<DashboardSnapshot> {
    const remindedPaidInvoices = this.database.select({ invoiceId: invoices.id, total: invoices.total }).from(invoices).innerJoin(invoiceChases, eq(invoiceChases.invoiceId, invoices.id)).innerJoin(stageInstances, eq(stageInstances.invoiceChaseId, invoiceChases.id)).innerJoin(outboundMessages, eq(outboundMessages.stageInstanceId, stageInstances.id)).where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'PAID'), isNotNull(invoices.resolvedAt), inArray(outboundMessages.status, ['ACCEPTED', 'DELIVERED']), sql`${outboundMessages.createdAt} <= ${invoices.resolvedAt}`)).groupBy(invoices.id, invoices.total).as('reminded_paid_invoices');
    const [overdue, approvalCount, pauseCount, taskCount, organisation, connections, paid] = await Promise.all([
      this.database.select({ count: count(), total: sql<string>`coalesce(sum(${invoices.amountDue}), 0)` }).from(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'AUTHORISED'), gt(invoices.amountDue, '0'), sql`${invoices.dueDate} < ${today}`)),
      this.database.select({ count: count() }).from(approvals).where(and(eq(approvals.organisationId, organisationId), eq(approvals.status, 'PENDING'))),
      this.database.select({ count: sql<number>`count(distinct ${pauses.contactId})` }).from(pauses).where(and(eq(pauses.organisationId, organisationId), eq(pauses.active, true), isNotNull(pauses.contactId))),
      this.database.select({ count: count() }).from(tasks).where(and(eq(tasks.organisationId, organisationId), eq(tasks.status, 'OPEN'))),
      this.database
        .select({
          lastSuccessfulSyncAt: organisations.lastSuccessfulSyncAt,
          baseCurrency: organisations.baseCurrency,
          timeZone: organisations.timeZone,
          edition: organisations.edition,
          xeroOAuthStatus: xeroConnections.status
        })
        .from(organisations)
        .leftJoin(xeroConnections, eq(xeroConnections.organisationId, organisations.id))
        .where(eq(organisations.id, organisationId))
        .limit(1),
      this.database.select({ provider: providerConnections.provider, enabled: providerConnections.enabled, authenticatedAt: providerConnections.lastSuccessfulAuthenticationAt }).from(providerConnections).where(eq(providerConnections.organisationId, organisationId)),
      this.database.select({ total: sql<string>`coalesce(sum(${remindedPaidInvoices.total}), 0)` }).from(remindedPaidInvoices)
    ]);
    const sinch = connections.find((row) => row.provider === 'SINCH');
    return {
      overdueTotal: overdue[0]?.total ?? '0',
      overdueCount: overdue[0]?.count ?? 0,
      awaitingApproval: approvalCount[0]?.count ?? 0,
      pausedCustomers: Number(pauseCount[0]?.count ?? 0),
      openEscalations: taskCount[0]?.count ?? 0,
      paidAfterReminders: paid[0]?.total ?? '0',
      lastXeroSync: organisation[0]?.lastSuccessfulSyncAt ?? null,
      xeroOAuthStatus: organisation[0]?.xeroOAuthStatus ?? null,
      legacyXeroEnabled: connections.some((row) => row.provider === 'XERO' && row.enabled),
      edition: organisation[0]?.edition ?? 'INTERNAL_LEGACY',
      baseCurrency: organisation[0]?.baseCurrency ?? 'AUD',
      timeZone: organisation[0]?.timeZone ?? 'Australia/Sydney',
      messagingHealthy: sinch?.enabled === true && sinch.authenticatedAt !== null
    };
  }
}
