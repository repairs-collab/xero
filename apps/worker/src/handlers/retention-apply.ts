import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql
} from 'drizzle-orm';

import {
  approvals,
  auditEvents,
  conversations,
  dataRequestCases,
  type Database,
  inboundMessages,
  invoiceChases,
  invoices,
  messageAttempts,
  operatorReplies,
  outboundMessages,
  retentionCases,
  stageInstances,
  webhookEvents
} from '@bc5000/db';
import { dataRequestReviewDecision } from '@bc5000/domain';
import type { JobPayloads } from '@bc5000/jobs';

const retained = '[RETAINED_METADATA_ONLY]';
const retainedPayload = { retainedMetadataOnly: true } as const;

export async function applyRetention(
  dependencies: {
    database: Database;
    clock: { now(): Date };
    batchSize?: number;
  },
  payload: JobPayloads['retention.apply']
) {
  const now = dependencies.clock.now();
  const batchSize = dependencies.batchSize ?? 500;
  const contentCutoff = new Date(now);
  contentCutoff.setUTCMonth(contentCutoff.getUTCMonth() - 24);
  const webhookCutoff = new Date(now);
  webhookCutoff.setUTCDate(webhookCutoff.getUTCDate() - 90);

  // The 30-day account deadline is a review boundary, not an automatic purge.
  // The status guard makes retries idempotent and leaves LEGAL_HOLD stable.
  const reviewRows = await dependencies.database
    .update(retentionCases)
    .set({
      status: 'REVIEW_REQUIRED',
      reviewAttempts: sql`${retentionCases.reviewAttempts} + 1`,
      lastReviewedAt: now,
      lastReviewError: null,
      updatedAt: now
    })
    .where(
      and(
        eq(retentionCases.organisationId, payload.organisationId),
        eq(retentionCases.status, 'SCHEDULED'),
        lte(retentionCases.reviewAfter, now)
      )
    )
    .returning({ organisationId: retentionCases.organisationId });
  const accountReviewRequired = reviewRows.length > 0;
  if (accountReviewRequired) {
    await dependencies.database.insert(auditEvents).values({
      organisationId: payload.organisationId,
      eventType: 'ACCOUNT_RETENTION_REVIEW_REQUIRED',
      entityType: 'ORGANISATION',
      entityId: payload.organisationId,
      afterValue: {
        automaticPurge: false,
        reason: 'POLICY_AND_LEGAL_REVIEW_REQUIRED'
      },
      occurredAt: now
    });
  }

  const dataRequestsReviewed = await dependencies.database.transaction(
    async (transaction) => {
      const [retentionCase] = await transaction
        .select({
          status: retentionCases.status,
          closureEpisodeId: retentionCases.closureEpisodeId,
          deletionEligibleAt: retentionCases.deletionEligibleAt,
          backupExpiryVerifiedAt: retentionCases.backupExpiryVerifiedAt,
          backupExpiryClosureEpisodeId:
            retentionCases.backupExpiryClosureEpisodeId
        })
        .from(retentionCases)
        .where(eq(retentionCases.organisationId, payload.organisationId))
        .for('update')
        .limit(1);
      const requests = await transaction
        .select({
          id: dataRequestCases.id,
          requestType: dataRequestCases.requestType,
          status: dataRequestCases.status,
          blockReason: dataRequestCases.blockReason,
          retentionClosureEpisodeId:
            dataRequestCases.retentionClosureEpisodeId,
          version: dataRequestCases.version
        })
        .from(dataRequestCases)
        .where(
          and(
            eq(dataRequestCases.organisationId, payload.organisationId),
            eq(dataRequestCases.status, 'VERIFIED'),
            lte(dataRequestCases.targetAt, now)
          )
        )
        .orderBy(dataRequestCases.targetAt, dataRequestCases.id)
        .limit(batchSize);

      let changed = 0;
      for (const request of requests) {
        const decision = dataRequestReviewDecision({
          requestType: request.requestType,
          legalHold: retentionCase?.status === 'LEGAL_HOLD',
          requestClosureEpisodeId: request.retentionClosureEpisodeId,
          currentClosureEpisodeId:
            retentionCase?.closureEpisodeId ?? null,
          deletionEligibleAt: retentionCase?.deletionEligibleAt ?? null,
          backupExpiryVerifiedAt:
            retentionCase?.backupExpiryVerifiedAt ?? null,
          backupExpiryClosureEpisodeId:
            retentionCase?.backupExpiryClosureEpisodeId ?? null,
          now
        });
        const { status, blockReason } = decision;
        if (
          request.status === status &&
          request.blockReason === blockReason
        ) {
          continue;
        }
        const [updated] = await transaction
          .update(dataRequestCases)
          .set({
            status,
            blockReason,
            version: request.version + 1,
            lastReviewedAt: now,
            updatedAt: now
          })
          .where(
            and(
              eq(dataRequestCases.organisationId, payload.organisationId),
              eq(dataRequestCases.id, request.id),
              eq(dataRequestCases.version, request.version)
            )
          )
          .returning({ id: dataRequestCases.id });
        if (updated === undefined) continue;
        await transaction.insert(auditEvents).values({
          organisationId: payload.organisationId,
          eventType: 'DATA_REQUEST_REVIEW_STATE_CHANGED',
          entityType: 'DATA_REQUEST',
          entityId: request.id,
          beforeValue: {
            status: request.status,
            blockReason: request.blockReason,
            version: request.version
          },
          afterValue: {
            status,
            blockReason,
            version: request.version + 1,
            automaticDeletion: false
          },
          occurredAt: now
        });
        changed += 1;
      }
      return changed;
    }
  );

  const [retentionGuard] = await dependencies.database
    .select({ status: retentionCases.status })
    .from(retentionCases)
    .where(eq(retentionCases.organisationId, payload.organisationId))
    .limit(1);
  const legalHoldActive = retentionGuard?.status === 'LEGAL_HOLD';
  if (legalHoldActive) {
    const result = {
      accountReviewRequired,
      dataRequestsReviewed,
      legalHoldActive,
      approvalsRedacted: 0,
      outboundRedacted: 0,
      attemptsRedacted: 0,
      inboundRedacted: 0,
      repliesRedacted: 0,
      webhooksDeleted: 0,
      contentCutoff: contentCutoff.toISOString(),
      webhookCutoff: webhookCutoff.toISOString()
    };
    await dependencies.database.insert(auditEvents).values({
      organisationId: payload.organisationId,
      eventType: 'RETENTION_APPLIED',
      entityType: 'ORGANISATION',
      entityId: payload.organisationId,
      afterValue: result,
      occurredAt: now
    });
    return result;
  }

  const oldInvoices = await dependencies.database
    .select({ id: invoices.id, contactId: invoices.contactId })
    .from(invoices)
    .where(
      and(
        eq(invoices.organisationId, payload.organisationId),
        lt(invoices.resolvedAt, contentCutoff)
      )
    )
    .limit(batchSize);
  const invoiceIds = oldInvoices.map((invoice) => invoice.id);

  let approvalsRedacted = 0;
  let outboundRedacted = 0;
  let attemptsRedacted = 0;
  if (invoiceIds.length > 0) {
    const approvalRows = await dependencies.database
      .select({ id: approvals.id })
      .from(approvals)
      .innerJoin(stageInstances, eq(stageInstances.id, approvals.stageInstanceId))
      .innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId))
      .where(
        and(
          eq(approvals.organisationId, payload.organisationId),
          inArray(invoiceChases.invoiceId, invoiceIds),
          ne(approvals.renderedPreview, retained)
        )
      )
      .limit(batchSize);
    if (approvalRows.length > 0) {
      approvalsRedacted = (
        await dependencies.database
          .update(approvals)
          .set({ renderedPreview: retained })
          .where(
            and(
              eq(approvals.organisationId, payload.organisationId),
              inArray(
                approvals.id,
                approvalRows.map((row) => row.id)
              )
            )
          )
          .returning({ id: approvals.id })
      ).length;
    }

    const directOutboundRows = await dependencies.database
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.organisationId, payload.organisationId),
          inArray(outboundMessages.invoiceId, invoiceIds),
          ne(outboundMessages.content, retained)
        )
      )
      .limit(batchSize);
    const linkedOutboundRows = await dependencies.database
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .innerJoin(
        stageInstances,
        eq(stageInstances.id, outboundMessages.stageInstanceId)
      )
      .innerJoin(invoiceChases, eq(invoiceChases.id, stageInstances.invoiceChaseId))
      .where(
        and(
          eq(outboundMessages.organisationId, payload.organisationId),
          inArray(invoiceChases.invoiceId, invoiceIds),
          ne(outboundMessages.content, retained)
        )
      )
      .limit(batchSize);
    const outboundIds = [
      ...new Set(
        [...directOutboundRows, ...linkedOutboundRows]
          .map((row) => row.id)
          .slice(0, batchSize)
      )
    ];
    if (outboundIds.length > 0) {
      outboundRedacted = (
        await dependencies.database
          .update(outboundMessages)
          .set({ content: retained, updatedAt: now })
          .where(
            and(
              eq(outboundMessages.organisationId, payload.organisationId),
              inArray(outboundMessages.id, outboundIds)
            )
          )
          .returning({ id: outboundMessages.id })
      ).length;

      const attemptRows = await dependencies.database
        .select({ id: messageAttempts.id })
        .from(messageAttempts)
        .where(
          and(
            eq(messageAttempts.organisationId, payload.organisationId),
            inArray(messageAttempts.outboundMessageId, outboundIds),
            isNotNull(messageAttempts.providerPayload)
          )
        )
        .limit(batchSize);
      if (attemptRows.length > 0) {
        attemptsRedacted = (
          await dependencies.database
            .update(messageAttempts)
            .set({ providerPayload: retainedPayload })
            .where(
              and(
                eq(messageAttempts.organisationId, payload.organisationId),
                inArray(
                  messageAttempts.id,
                  attemptRows.map((row) => row.id)
                )
              )
            )
            .returning({ id: messageAttempts.id })
        ).length;
      }
    }
  }

  const candidateContacts = [
    ...new Set(oldInvoices.map((invoice) => invoice.contactId))
  ];
  const retainedContacts: string[] = [];
  for (const contactId of candidateContacts) {
    const recent = await dependencies.database
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, payload.organisationId),
          eq(invoices.contactId, contactId),
          or(
            isNull(invoices.resolvedAt),
            gte(invoices.resolvedAt, contentCutoff)
          )
        )
      )
      .limit(1);
    if (recent.length === 0) retainedContacts.push(contactId);
  }

  let inboundRedacted = 0;
  let repliesRedacted = 0;
  if (retainedContacts.length > 0) {
    const conversationRows = await dependencies.database
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organisationId, payload.organisationId),
          inArray(conversations.contactId, retainedContacts)
        )
      )
      .limit(batchSize);
    const conversationIds = conversationRows.map((row) => row.id);
    if (conversationIds.length > 0) {
      const inboundRows = await dependencies.database
        .select({ id: inboundMessages.id })
        .from(inboundMessages)
        .where(
          and(
            eq(inboundMessages.organisationId, payload.organisationId),
            inArray(inboundMessages.conversationId, conversationIds),
            ne(inboundMessages.body, retained)
          )
        )
        .limit(batchSize);
      if (inboundRows.length > 0) {
        inboundRedacted = (
          await dependencies.database
            .update(inboundMessages)
            .set({ body: retained, providerPayload: retainedPayload })
            .where(
              and(
                eq(inboundMessages.organisationId, payload.organisationId),
                inArray(
                  inboundMessages.id,
                  inboundRows.map((row) => row.id)
                )
              )
            )
            .returning({ id: inboundMessages.id })
        ).length;
      }
      const replyRows = await dependencies.database
        .select({ id: operatorReplies.id })
        .from(operatorReplies)
        .where(
          and(
            eq(operatorReplies.organisationId, payload.organisationId),
            inArray(operatorReplies.conversationId, conversationIds),
            ne(operatorReplies.content, retained)
          )
        )
        .limit(batchSize);
      if (replyRows.length > 0) {
        repliesRedacted = (
          await dependencies.database
            .update(operatorReplies)
            .set({ content: retained, updatedAt: now })
            .where(
              and(
                eq(operatorReplies.organisationId, payload.organisationId),
                inArray(
                  operatorReplies.id,
                  replyRows.map((row) => row.id)
                )
              )
            )
            .returning({ id: operatorReplies.id })
        ).length;
      }
    }
  }

  // An old but unprocessed event may be the only recoverable evidence of a
  // provider action, so age alone must never remove it.
  const expiredWebhooks = await dependencies.database
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.organisationId, payload.organisationId),
        isNotNull(webhookEvents.processedAt),
        lt(webhookEvents.receivedAt, webhookCutoff)
      )
    )
    .limit(batchSize);
  const webhooksDeleted =
    expiredWebhooks.length === 0
      ? 0
      : (
          await dependencies.database
            .delete(webhookEvents)
            .where(
              and(
                eq(webhookEvents.organisationId, payload.organisationId),
                inArray(
                  webhookEvents.id,
                  expiredWebhooks.map((row) => row.id)
                )
              )
            )
            .returning({ id: webhookEvents.id })
        ).length;

  const result = {
    accountReviewRequired,
    dataRequestsReviewed,
    legalHoldActive,
    approvalsRedacted,
    outboundRedacted,
    attemptsRedacted,
    inboundRedacted,
    repliesRedacted,
    webhooksDeleted,
    contentCutoff: contentCutoff.toISOString(),
    webhookCutoff: webhookCutoff.toISOString()
  };
  await dependencies.database.insert(auditEvents).values({
    organisationId: payload.organisationId,
    eventType: 'RETENTION_APPLIED',
    entityType: 'ORGANISATION',
    entityId: payload.organisationId,
    afterValue: result,
    occurredAt: now
  });
  return result;
}
