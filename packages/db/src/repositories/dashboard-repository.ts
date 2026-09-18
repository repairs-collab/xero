import { and, count, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { outboundMessages } from '../schema/messaging.js';
import { pauses, tasks } from '../schema/operations.js';
import { organisations, providerConnections } from '../schema/organisation.js';
import { invoices } from '../schema/receivables.js';
import { approvals, invoiceChases, stageInstances } from '../schema/reminders.js';

export interface DashboardSnapshot {
  overdueTotal: string;
  overdueCount: number;
  awaitingApproval: number;
  pausedCustomers: number;
  openEscalations: number;
  paidAfterReminders: string;
  lastXeroSync: Date | null;
  xeroHealthy: boolean;
  sinchHealthy: boolean;
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
      this.database.select({ lastSuccessfulSyncAt: organisations.lastSuccessfulSyncAt, baseCurrency: organisations.baseCurrency }).from(organisations).where(eq(organisations.id, organisationId)).limit(1),
      this.database.select({ provider: providerConnections.provider, enabled: providerConnections.enabled, authenticatedAt: providerConnections.lastSuccessfulAuthenticationAt }).from(providerConnections).where(eq(providerConnections.organisationId, organisationId)),
      this.database.select({ total: sql<string>`coalesce(sum(${remindedPaidInvoices.total}), 0)` }).from(remindedPaidInvoices)
    ]);
    const health = new Map(connections.map((row) => [row.provider, row.enabled && row.authenticatedAt !== null]));
    return {
      overdueTotal: overdue[0]?.total ?? '0',
      overdueCount: overdue[0]?.count ?? 0,
      awaitingApproval: approvalCount[0]?.count ?? 0,
      pausedCustomers: Number(pauseCount[0]?.count ?? 0),
      openEscalations: taskCount[0]?.count ?? 0,
      paidAfterReminders: paid[0]?.total ?? '0',
      lastXeroSync: organisation[0]?.lastSuccessfulSyncAt ?? null,
      xeroHealthy: health.get('XERO') ?? false,
      sinchHealthy: health.get('SINCH') ?? false
    };
  }
}
