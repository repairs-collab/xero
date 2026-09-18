import { and, eq } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  approvals,
  auditEvents,
  type Database,
  invoiceChases,
  invoices,
  stageInstances
} from '@bc5000/db/web';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export class StaleApproval extends Error {
  readonly code = 'APPROVAL_STALE';
  constructor() {
    super('APPROVAL_STALE');
    this.name = 'StaleApproval';
  }
}

interface ApprovalServiceDependencies {
  database: Database;
  publisher: JobPublisher;
  clock: { now(): Date };
}

export function createApprovalService(dependencies: ApprovalServiceDependencies) {
  const decide = async (
    session: AppSession,
    input: { organisationId: string; approvalId: string },
    decision: 'APPROVED' | 'REJECTED'
  ): Promise<{ stageInstanceId: string }> => {
    authorise(session, 'reminder.approve', input.organisationId);
    const outcome = await dependencies.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ approval: approvals, stage: stageInstances, invoice: invoices })
        .from(approvals)
        .innerJoin(stageInstances, eq(stageInstances.id, approvals.stageInstanceId))
        .innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId))
        .innerJoin(invoices, eq(invoices.id, invoiceChases.invoiceId))
        .where(and(eq(approvals.organisationId, input.organisationId), eq(approvals.id, input.approvalId)))
        .for('update')
        .limit(1);
      if (row === undefined || row.approval.status !== 'PENDING') throw new Error('APPROVAL_NOT_PENDING');
      const now = dependencies.clock.now();
      const stale = row.approval.expiresAt <= now || row.approval.sourceVersion !== row.invoice.syncVersion || row.stage.sourceVersion !== row.invoice.syncVersion;
      if (stale) {
        await transaction.update(approvals).set({ status: 'EXPIRED', decidedByUserId: session.userId, decidedAt: now }).where(eq(approvals.id, row.approval.id));
        await transaction.update(stageInstances).set({ status: 'CANCELLED', updatedAt: now }).where(eq(stageInstances.id, row.stage.id));
        await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'APPROVAL_EXPIRED_STALE', entityType: 'APPROVAL', entityId: row.approval.id, beforeValue: { sourceVersion: row.approval.sourceVersion }, afterValue: { invoiceSourceVersion: row.invoice.syncVersion }, occurredAt: now });
        return { kind: 'stale' as const, stageInstanceId: row.stage.id };
      }
      await transaction.update(approvals).set({ status: decision, decidedByUserId: session.userId, decidedAt: now }).where(eq(approvals.id, row.approval.id));
      await transaction.update(stageInstances).set({ status: decision === 'APPROVED' ? 'QUEUED' : 'REJECTED', updatedAt: now }).where(eq(stageInstances.id, row.stage.id));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: `REMINDER_${decision}`, entityType: 'APPROVAL', entityId: row.approval.id, beforeValue: { status: row.approval.status }, afterValue: { status: decision }, occurredAt: now });
      return { kind: 'decided' as const, stageInstanceId: row.stage.id };
    });
    if (outcome.kind === 'stale') throw new StaleApproval();
    if (decision === 'APPROVED') {
      await dependencies.publisher.publish(jobNames.reminderExecute, { organisationId: input.organisationId, stageInstanceId: outcome.stageInstanceId }, { singletonKey: `approval:${input.approvalId}` });
    }
    return { stageInstanceId: outcome.stageInstanceId };
  };

  const approveReminder = (session: AppSession, input: { organisationId: string; approvalId: string }) => decide(session, input, 'APPROVED');
  const rejectReminder = (session: AppSession, input: { organisationId: string; approvalId: string }) => decide(session, input, 'REJECTED');

  const snoozeReminder = async (session: AppSession, input: { organisationId: string; approvalId: string; until: Date }): Promise<void> => {
    authorise(session, 'reminder.approve', input.organisationId);
    if (input.until <= dependencies.clock.now()) throw new Error('SNOOZE_MUST_BE_FUTURE');
    await dependencies.database.transaction(async (transaction) => {
      const [approval] = await transaction.select().from(approvals).where(and(eq(approvals.organisationId, input.organisationId), eq(approvals.id, input.approvalId), eq(approvals.status, 'PENDING'))).for('update').limit(1);
      if (approval === undefined) throw new Error('APPROVAL_NOT_PENDING');
      await transaction.update(approvals).set({ status: 'EXPIRED', decidedByUserId: session.userId, decidedAt: dependencies.clock.now() }).where(eq(approvals.id, approval.id));
      await transaction.update(stageInstances).set({ status: 'SNOOZED', scheduledAt: input.until, updatedAt: dependencies.clock.now() }).where(eq(stageInstances.id, approval.stageInstanceId));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'REMINDER_SNOOZED', entityType: 'APPROVAL', entityId: approval.id, afterValue: { until: input.until.toISOString() }, occurredAt: dependencies.clock.now() });
    });
  };

  const bulkApprove = async (session: AppSession, input: { organisationId: string; approvalIds: string[] }) => {
    const results: { approvalId: string; status: 'APPROVED' | 'STALE' | 'FAILED'; reason?: string }[] = [];
    for (const approvalId of input.approvalIds) {
      try {
        await approveReminder(session, { organisationId: input.organisationId, approvalId });
        results.push({ approvalId, status: 'APPROVED' });
      } catch (error) {
        if (error instanceof StaleApproval) results.push({ approvalId, status: 'STALE' });
        else results.push({ approvalId, status: 'FAILED', reason: error instanceof Error ? error.message : 'UNKNOWN' });
      }
    }
    return results;
  };

  return { approveReminder, rejectReminder, snoozeReminder, bulkApprove };
}
