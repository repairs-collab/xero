import { eq } from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  type DbTransaction,
  organisations,
  retentionCases
} from '@bc5000/db';

export interface RetentionLegalHoldInput {
  organisationId: string;
  actorUserId?: string;
  recordedAt: Date;
  reason: string;
}

/**
 * Retention cleanup, cancellation and legal-hold writers serialize on the
 * organisation row before reading or changing retention state. This also
 * covers the first legal hold, when no retention row exists yet.
 */
export async function lockRetentionOrganisation(
  transaction: DbTransaction,
  organisationId: string
): Promise<void> {
  const [organisation] = await transaction
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for('update')
    .limit(1);
  if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
}

export async function writeRetentionLegalHold(
  transaction: DbTransaction,
  input: RetentionLegalHoldInput
): Promise<'RECORDED' | 'ALREADY_APPLIED'> {
  await lockRetentionOrganisation(transaction, input.organisationId);
  const [current] = await transaction
    .select()
    .from(retentionCases)
    .where(eq(retentionCases.organisationId, input.organisationId))
    .for('update')
    .limit(1);
  if (current?.status === 'LEGAL_HOLD') return 'ALREADY_APPLIED';

  if (current === undefined) {
    await transaction.insert(retentionCases).values({
      organisationId: input.organisationId,
      source: 'CUSTOMER_REQUEST',
      status: 'LEGAL_HOLD',
      disconnectedAt: input.recordedAt,
      reviewAfter: new Date(
        input.recordedAt.getTime() + 30 * 24 * 60 * 60 * 1000
      ),
      closureEffectiveAt: input.recordedAt,
      createdAt: input.recordedAt,
      updatedAt: input.recordedAt
    });
  } else {
    await transaction
      .update(retentionCases)
      .set({ status: 'LEGAL_HOLD', updatedAt: input.recordedAt })
      .where(eq(retentionCases.organisationId, input.organisationId));
  }

  await transaction.insert(auditEvents).values({
    organisationId: input.organisationId,
    actorUserId: input.actorUserId,
    eventType: 'RETENTION_LEGAL_HOLD_PLACED',
    entityType: 'ORGANISATION',
    entityId: input.organisationId,
    beforeValue: current === undefined ? null : { status: current.status },
    afterValue: { status: 'LEGAL_HOLD', reason: input.reason },
    occurredAt: input.recordedAt
  });
  return 'RECORDED';
}

export async function placeRetentionLegalHold(
  database: Database,
  input: RetentionLegalHoldInput
): Promise<'RECORDED' | 'ALREADY_APPLIED'> {
  return database.transaction((transaction) =>
    writeRetentionLegalHold(transaction, input)
  );
}
