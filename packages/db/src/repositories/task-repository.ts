import { and, eq } from 'drizzle-orm';

import type { Database } from '../connection.js';
import { auditEvents, tasks } from '../schema/operations.js';

export class PostgresTaskRepository {
  constructor(private readonly database: Database) {}

  async complete(input: { organisationId: string; taskId: string; actorUserId: string; resolutionNote: string; now: Date }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.organisationId, input.organisationId), eq(tasks.id, input.taskId))).for('update').limit(1);
      if (task === undefined) throw new Error('TASK_NOT_FOUND');
      if (task.status !== 'OPEN') throw new Error('TASK_NOT_OPEN');
      await transaction.update(tasks).set({ status: 'COMPLETED', resolutionNote: input.resolutionNote, completedAt: input.now, updatedAt: input.now }).where(eq(tasks.id, task.id));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: input.actorUserId, eventType: 'ESCALATION_TASK_COMPLETED', entityType: 'TASK', entityId: task.id, beforeValue: { status: task.status }, afterValue: { status: 'COMPLETED', resolutionNote: input.resolutionNote, messagingChanged: false }, occurredAt: input.now });
    });
  }
}
