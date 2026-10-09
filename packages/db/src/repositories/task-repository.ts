import { and, eq, sql } from 'drizzle-orm';

import type { Database, DbTransaction } from '../connection.js';
import { auditEvents, tasks } from '../schema/operations.js';

export class PostgresTaskRepository {
  constructor(private readonly database: Database) {}

  async ensureVoiceContactReview(
    input: {
      organisationId: string;
      contactId: string;
      sequenceId: string | null;
      invoiceId: string | null;
      summary: string;
      now: Date;
    },
    transaction?: DbTransaction
  ): Promise<{ taskId: string; created: boolean }> {
    const ensure = async (executor: DbTransaction) => {
      const lockKey = [
        input.organisationId,
        input.contactId,
        'VOICE_CONTACT_REVIEW'
      ].join(':');
      await executor.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      );
      const [existing] = await executor
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.organisationId, input.organisationId),
            eq(tasks.contactId, input.contactId),
            eq(tasks.kind, 'VOICE_CONTACT_REVIEW'),
            eq(tasks.status, 'OPEN')
          )
        )
        .for('update')
        .limit(1);
      if (existing !== undefined) {
        await executor
          .update(tasks)
          .set({
            sequenceId: input.sequenceId,
            invoiceId: input.invoiceId,
            summary: input.summary,
            updatedAt: input.now
          })
          .where(eq(tasks.id, existing.id));
        return { taskId: existing.id, created: false };
      }
      const [created] = await executor
        .insert(tasks)
        .values({
          organisationId: input.organisationId,
          kind: 'VOICE_CONTACT_REVIEW',
          contactId: input.contactId,
          sequenceId: input.sequenceId,
          invoiceId: input.invoiceId,
          status: 'OPEN',
          summary: input.summary,
          createdAt: input.now,
          updatedAt: input.now
        })
        .returning({ id: tasks.id });
      if (created === undefined) throw new Error('TASK_NOT_CREATED');
      return { taskId: created.id, created: true };
    };
    return transaction === undefined
      ? this.database.transaction(ensure)
      : ensure(transaction);
  }

  async complete(input: { organisationId: string; taskId: string; actorUserId: string; resolutionNote: string; now: Date }, transaction?: DbTransaction): Promise<void> {
    const complete = async (executor: DbTransaction): Promise<void> => {
      const [task] = await executor.select().from(tasks).where(and(eq(tasks.organisationId, input.organisationId), eq(tasks.id, input.taskId))).for('update').limit(1);
      if (task === undefined) throw new Error('TASK_NOT_FOUND');
      if (task.status !== 'OPEN') throw new Error('TASK_NOT_OPEN');
      await executor.update(tasks).set({ status: 'COMPLETED', resolutionNote: input.resolutionNote, completedAt: input.now, updatedAt: input.now }).where(eq(tasks.id, task.id));
      await executor.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: input.actorUserId, eventType: 'ESCALATION_TASK_COMPLETED', entityType: 'TASK', entityId: task.id, beforeValue: { status: task.status }, afterValue: { status: 'COMPLETED', resolutionNote: input.resolutionNote, messagingChanged: false }, occurredAt: input.now });
    };
    if (transaction === undefined) {
      await this.database.transaction(complete);
    } else {
      await complete(transaction);
    }
  }
}
