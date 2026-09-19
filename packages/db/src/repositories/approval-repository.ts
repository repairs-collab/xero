import { and, eq, inArray, lt } from 'drizzle-orm';

import type { Database } from '../client.js';
import { approvals, stageInstances } from '../schema/reminders.js';

export interface CreatePendingApprovalInput {
  organisationId: string;
  stageInstanceId: string;
  renderedPreview: string;
  sourceVersion: number;
  expiresAt: Date;
}

export class PostgresApprovalRepository {
  constructor(private readonly database: Database) {}

  async createPending(
    input: CreatePendingApprovalInput
  ): Promise<string> {
    const [created] = await this.database
      .insert(approvals)
      .values({ ...input, status: 'PENDING' })
      .returning({ id: approvals.id });
    if (created === undefined) throw new Error('Approval was not created');
    return created.id;
  }

  async expirePastDue(organisationId: string, now: Date): Promise<number> {
    const expired = await this.database
      .update(approvals)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          eq(approvals.organisationId, organisationId),
          inArray(approvals.status, ['PENDING', 'APPROVED']),
          lt(approvals.expiresAt, now)
        )
      )
      .returning({ stageInstanceId: approvals.stageInstanceId });

    if (expired.length > 0) {
      await this.database
        .update(stageInstances)
        .set({ status: 'CANCELLED', updatedAt: now })
        .where(
          and(
            eq(stageInstances.organisationId, organisationId),
            inArray(
              stageInstances.id,
              expired.map((approval) => approval.stageInstanceId)
            )
          )
        );
    }
    return expired.length;
  }

  async expireForStage(
    organisationId: string,
    stageInstanceId: string
  ): Promise<void> {
    await this.database
      .update(approvals)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          eq(approvals.organisationId, organisationId),
          eq(approvals.stageInstanceId, stageInstanceId),
          inArray(approvals.status, ['PENDING', 'APPROVED'])
        )
      );
  }
}
