import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  approvals,
  auditEvents,
  contacts,
  type Database,
  invoiceChases,
  invoices,
  outboundMessages,
  PostgresReminderWhitelistRepository,
  reminderWhitelistEntries,
  stageInstances,
  tasks,
  users,
  type ReminderWhitelistScope
} from '@bc5000/db/web';
import type { JobPublisher } from '@bc5000/jobs';

export interface ReminderWhitelistServiceDependencies {
  database: Database;
  publisher: JobPublisher;
  clock: { now(): Date };
}

export interface AddReminderWhitelistInput {
  organisationId: string;
  scope: ReminderWhitelistScope;
  contactId: string;
  invoiceId?: string;
  reason?: string;
}

const emptyCancellation = {
  cancelledApprovals: 0,
  cancelledStages: 0,
  cancelledMessages: 0,
  cancelledTasks: 0
};

const unsentStageStatuses = [
  'CALCULATED',
  'AWAITING_APPROVAL',
  'SCHEDULED',
  'DUE',
  'PENDING_APPROVAL',
  'QUEUED',
  'PAUSED',
  'SNOOZED'
] as const;

const reminderOutboundSources = [
  'AUTOMATED_REMINDER',
  'MANUAL_REMINDER',
  'ESCALATION_SMS',
  'XERO_EMAIL'
] as const;

export function createReminderWhitelistService(
  dependencies: ReminderWhitelistServiceDependencies
) {
  const repository = new PostgresReminderWhitelistRepository(
    dependencies.database
  );

  const add = async (
    session: AppSession,
    input: AddReminderWhitelistInput
  ) => {
    authorise(session, 'reminder-whitelist.add', input.organisationId);
    if (input.scope === 'INVOICE' && input.invoiceId === undefined) {
      throw new Error('REMINDER_WHITELIST_INVOICE_REQUIRED');
    }
    const reason = input.reason?.trim();
    if (reason !== undefined && reason.length > 500) {
      throw new Error('REMINDER_WHITELIST_REASON_TOO_LONG');
    }
    const now = dependencies.clock.now();
    return dependencies.database.transaction(async (transaction) => {
      await repository.lockTarget(transaction, input);
      const added = await repository.add(transaction, {
        organisationId: input.organisationId,
        scope: input.scope,
        contactId: input.contactId,
        ...(input.invoiceId === undefined ? {} : { invoiceId: input.invoiceId }),
        ...(reason === undefined || reason === '' ? {} : { reason }),
        actorUserId: session.userId,
        now
      });
      if (!added.created) {
        return {
          entryId: added.entry.id,
          created: false,
          ...emptyCancellation
        };
      }

      const affectedStages = await transaction
        .select({ id: stageInstances.id })
        .from(stageInstances)
        .innerJoin(
          invoiceChases,
          and(
            eq(invoiceChases.id, stageInstances.invoiceChaseId),
            eq(invoiceChases.organisationId, input.organisationId)
          )
        )
        .where(
          and(
            eq(stageInstances.organisationId, input.organisationId),
            inArray(stageInstances.status, [...unsentStageStatuses]),
            input.scope === 'CLIENT'
              ? eq(invoiceChases.customerId, input.contactId)
              : eq(invoiceChases.invoiceId, input.invoiceId!)
          )
        );
      const stageIds = affectedStages.map((stage) => stage.id);

      const cancelledApprovals =
        stageIds.length === 0
          ? []
          : await transaction
              .update(approvals)
              .set({ status: 'EXPIRED' })
              .where(
                and(
                  eq(approvals.organisationId, input.organisationId),
                  inArray(approvals.status, ['PENDING', 'APPROVED']),
                  inArray(approvals.stageInstanceId, stageIds)
                )
              )
              .returning({ id: approvals.id });
      const cancelledStages =
        stageIds.length === 0
          ? []
          : await transaction
              .update(stageInstances)
              .set({ status: 'CANCELLED', completedAt: now, updatedAt: now })
              .where(
                and(
                  eq(stageInstances.organisationId, input.organisationId),
                  inArray(stageInstances.id, stageIds)
                )
              )
              .returning({ id: stageInstances.id });
      const cancelledMessages = await transaction
        .update(outboundMessages)
        .set({
          status: 'CANCELLED',
          failureReason: 'REMINDER_WHITELISTED',
          completedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(outboundMessages.organisationId, input.organisationId),
            inArray(outboundMessages.status, ['PENDING', 'QUEUED']),
            inArray(outboundMessages.source, [...reminderOutboundSources]),
            or(
              stageIds.length === 0
                ? undefined
                : inArray(outboundMessages.stageInstanceId, stageIds),
              input.scope === 'CLIENT'
                ? eq(outboundMessages.contactId, input.contactId)
                : eq(outboundMessages.invoiceId, input.invoiceId!)
            )
          )
        )
        .returning({ id: outboundMessages.id });
      const cancelledTasks = await transaction
        .update(tasks)
        .set({
          status: 'CANCELLED',
          resolutionNote: 'Cancelled by Reminder Whitelist',
          updatedAt: now
        })
        .where(
          and(
            eq(tasks.organisationId, input.organisationId),
            eq(tasks.status, 'OPEN'),
            eq(tasks.kind, 'DEBT_ESCALATION'),
            input.scope === 'CLIENT'
              ? eq(tasks.contactId, input.contactId)
              : eq(tasks.invoiceId, input.invoiceId!)
          )
        )
        .returning({ id: tasks.id });

      const counts = {
        cancelledApprovals: cancelledApprovals.length,
        cancelledStages: cancelledStages.length,
        cancelledMessages: cancelledMessages.length,
        cancelledTasks: cancelledTasks.length
      };
      await transaction.insert(auditEvents).values([
        {
          organisationId: input.organisationId,
          actorUserId: session.userId,
          eventType: 'REMINDER_WHITELIST_ADDED',
          entityType: 'REMINDER_WHITELIST',
          entityId: added.entry.id,
          afterValue: {
            scope: input.scope,
            contactId: input.contactId,
            invoiceId: input.invoiceId ?? null,
            reason: reason === undefined || reason === '' ? null : reason
          },
          occurredAt: now
        },
        {
          organisationId: input.organisationId,
          actorUserId: session.userId,
          eventType: 'REMINDERS_CANCELLED_BY_WHITELIST',
          entityType: 'REMINDER_WHITELIST',
          entityId: added.entry.id,
          afterValue: counts,
          occurredAt: now
        }
      ]);
      return { entryId: added.entry.id, created: true, ...counts };
    });
  };

  const remove = async (
    session: AppSession,
    input: { organisationId: string; entryId: string }
  ) => {
    authorise(session, 'reminder-whitelist.remove', input.organisationId);
    const now = dependencies.clock.now();
    const removed = await dependencies.database.transaction(
      async (transaction) => {
        const [entry] = await transaction
          .select()
          .from(reminderWhitelistEntries)
          .where(
            and(
              eq(reminderWhitelistEntries.organisationId, input.organisationId),
              eq(reminderWhitelistEntries.id, input.entryId)
            )
          )
          .for('update')
          .limit(1);
        if (entry === undefined) {
          throw new Error('REMINDER_WHITELIST_ENTRY_NOT_FOUND');
        }
        await repository.lockTarget(transaction, {
          organisationId: input.organisationId,
          contactId: entry.contactId,
          ...(entry.invoiceId === null ? {} : { invoiceId: entry.invoiceId })
        });
        if (entry.removedAt !== null) return false;
        await repository.remove(transaction, {
          organisationId: input.organisationId,
          entryId: entry.id,
          actorUserId: session.userId,
          now
        });
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: session.userId,
          eventType: 'REMINDER_WHITELIST_REMOVED',
          entityType: 'REMINDER_WHITELIST',
          entityId: entry.id,
          beforeValue: {
            scope: entry.scope,
            contactId: entry.contactId,
            invoiceId: entry.invoiceId,
            reason: entry.reason
          },
          occurredAt: now
        });
        return true;
      }
    );
    const recalculationJobId = await dependencies.publisher.publish(
      'reminders.calculate',
      { organisationId: input.organisationId },
      { singletonKey: `reminders.calculate:${input.organisationId}` }
    );
    return { removed, recalculationJobId };
  };

  const list = async (
    session: AppSession,
    input: { organisationId: string }
  ) => {
    authorise(session, 'reminder-whitelist.add', input.organisationId);
    return dependencies.database
      .select({
        entry: reminderWhitelistEntries,
        contactName: contacts.name,
        invoiceNumber: invoices.invoiceNumber,
        createdByName: users.displayName
      })
      .from(reminderWhitelistEntries)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, reminderWhitelistEntries.contactId),
          eq(contacts.organisationId, input.organisationId)
        )
      )
      .leftJoin(
        invoices,
        and(
          eq(invoices.id, reminderWhitelistEntries.invoiceId),
          eq(invoices.organisationId, input.organisationId)
        )
      )
      .leftJoin(users, eq(users.id, reminderWhitelistEntries.createdByUserId))
      .where(
        and(
          eq(reminderWhitelistEntries.organisationId, input.organisationId),
          isNull(reminderWhitelistEntries.removedAt)
        )
      )
      .orderBy(desc(reminderWhitelistEntries.createdAt));
  };

  return { add, remove, list };
}
