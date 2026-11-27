import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  type Database,
  organisations,
  platformAdminAuditEvents,
  replyNumberProvisioningRequests,
  smsNumberPool,
  users
} from '@bc5000/db/web';

export async function linkPlatformSinchAccount(
  database: Database,
  actorUserId: string,
  input: { organisationId: string; accountId: string; confirmed: boolean; now: Date }
) {
  if (
    !input.confirmed ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.accountId) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.organisationId)
  ) return 'VALIDATION';

  try {
    return await database.transaction(async (transaction) => {
      const [owner] = await transaction.select({ id: users.id }).from(users)
        .where(and(eq(users.id, actorUserId), eq(users.platformRole, 'OWNER'), isNull(users.disabledAt)))
        .for('update');
      if (!owner) return 'NOT_OWNER';

      const [company] = await transaction.select({
        edition: organisations.edition,
        sinchSharedAccountId: organisations.sinchSharedAccountId
      }).from(organisations)
        .where(eq(organisations.id, input.organisationId)).for('update');
      if (company?.edition !== 'SOLO') return 'NOT_FOUND';
      if (company.sinchSharedAccountId === input.accountId) return 'LINKED';
      if (company.sinchSharedAccountId !== null) return 'ALREADY_LINKED';

      const [number] = await transaction.select({ id: smsNumberPool.id }).from(smsNumberPool)
        .where(and(eq(smsNumberPool.organisationId, input.organisationId),
          inArray(smsNumberPool.status, ['READY', 'RESERVED', 'QUARANTINED']))).limit(1);
      const [order] = await transaction.select({ id: replyNumberProvisioningRequests.id })
        .from(replyNumberProvisioningRequests)
        .where(and(eq(replyNumberProvisioningRequests.organisationId, input.organisationId),
          inArray(replyNumberProvisioningRequests.status, ['APPROVED_FOR_MANUAL_ORDER', 'MANUAL_ORDER_RECORDED'])))
        .limit(1);
      if (number || order) return 'DEDICATED_NUMBER_IN_USE';

      await transaction.update(organisations).set({
        sinchSharedAccountId: input.accountId,
        sinchSharedAccountLinkedAt: input.now,
        updatedAt: input.now
      }).where(eq(organisations.id, input.organisationId));
      await transaction.insert(platformAdminAuditEvents).values({
        actorUserId: owner.id,
        targetOrganisationId: input.organisationId,
        eventType: 'SINCH_SHARED_ACCOUNT_LINKED',
        entityType: 'ORGANISATION',
        entityId: input.organisationId,
        reason: 'Owner confirmed the Australian shared sender and reply configuration',
        occurredAt: input.now
      });
      return 'LINKED';
    });
  } catch (error) {
    const pgError = error instanceof Error ? error.cause : undefined;
    if (typeof pgError === 'object' && pgError !== null &&
        'constraint' in pgError && pgError.constraint === 'organisations_sinch_shared_account_uq') {
      return 'ACCOUNT_IN_USE';
    }
    throw error;
  }
}
