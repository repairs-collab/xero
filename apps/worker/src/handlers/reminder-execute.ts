import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import { decideDebtContactWindow, renderSms } from '@bc5000/domain';

import {
  approvals,
  type Database,
  disputes,
  PostgresDebtContactRepository,
  PostgresMessageRepository,
  stageInstances,
  tasks
} from '@bc5000/db';
import {
  SinchAuthenticationFailure,
  SinchPermanentSubmissionFailure,
  SinchRateLimited,
  SinchUnknownSubmissionOutcome,
  SinchValidationFailure
} from '@bc5000/integrations/sinch';
import type { SmsProvider } from '@bc5000/integrations/sms';
import {
  XeroEmailPermanentFailure,
  XeroRateLimited,
  XeroRequestFailure,
  XeroTransientFailure
} from '@bc5000/integrations/xero';
import type { JobPayloads } from '@bc5000/jobs';

import {
  revalidateAutomaticReminderSchedule,
  revalidateReminder,
  type RevalidationXeroClient,
  type StopReason
} from '../services/pre-send-revalidation.js';
import {
  dispatchWithProviderSendLock,
  type EntitlementSendBlocker,
  markProviderSendBlocked,
  releaseSmsUsageReservation
} from '../services/provider-send-policy.js';

export interface ReminderExecutionClock {
  now(): Date;
}

export interface ReminderExecutionXero extends RevalidationXeroClient {
  emailInvoice(invoiceId: string, beforeRequest?: () => Promise<void>): Promise<{ kind: 'accepted' }>;
}

export interface XeroEmailAllowance {
  hasSafeHeadroom(organisationId: string, now: Date): Promise<boolean>;
}

export interface ReminderExecutionDependencies {
  database: Database;
  clock: ReminderExecutionClock;
  xero: ReminderExecutionXero;
  sinch: SmsProvider;
  callbackUrl: string;
  holidays: { list(organisationId: string): readonly string[] };
  xeroEmailAllowance: XeroEmailAllowance;
}

export type ExecutionOutcome =
  | {
      kind: 'sent';
      provider: 'SINCH' | 'XERO';
      providerMessageId: string | null;
    }
  | { kind: 'dry-run' }
  | {
      kind: 'cancelled';
      reason:
        | StopReason
        | EntitlementSendBlocker
        | 'XERO_EMAIL_ALLOWANCE'
        | 'CONTACT_WINDOW_CLOSED'
        | 'DAILY_CONTACT_LIMIT'
        | 'OPERATIONAL_MAINTENANCE'
        | 'UNSUPPORTED_SENDING_STATE';
    }
  | { kind: 'rejected'; reason: 'PROVIDER_REJECTED' | 'RATE_LIMITED' }
  | { kind: 'unknown' }
  | { kind: 'in-progress' };

const idempotencyKey = (
  stageInstanceId: string,
  channel: string,
  sourceVersion: number
): string => `${stageInstanceId}:${channel}:${sourceVersion.toString()}`;

const outcomeFromStored = (input: {
  status: string;
  providerMessageId: string | null;
  channel: 'SMS' | 'XERO_EMAIL';
}): ExecutionOutcome => {
  if (input.status === 'ACCEPTED' || input.status === 'DELIVERED') {
    return {
      kind: 'sent',
      provider: input.channel === 'SMS' ? 'SINCH' : 'XERO',
      providerMessageId: input.providerMessageId
    };
  }
  if (input.status === 'DRY_RUN') return { kind: 'dry-run' };
  if (input.status === 'UNKNOWN') return { kind: 'unknown' };
  if (input.status === 'FAILED') {
    return { kind: 'rejected', reason: 'PROVIDER_REJECTED' };
  }
  return { kind: 'in-progress' };
};

const cancelStage = async (
  database: Database,
  organisationId: string,
  stageInstanceId: string,
  reason: StopReason | 'XERO_EMAIL_ALLOWANCE',
  now: Date,
  expectedApprovalId?: string | null
): Promise<void> => {
  await database.transaction(async (transaction) => {
    const [stage] = await transaction
      .select({ status: stageInstances.status })
      .from(stageInstances)
      .where(
        and(
          eq(stageInstances.organisationId, organisationId),
          eq(stageInstances.id, stageInstanceId)
        )
      )
      .for('update');
    if (stage === undefined || stage.status !== 'QUEUED') return;
    if (expectedApprovalId !== undefined) {
      const [latestApproval] = await transaction
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.organisationId, organisationId),
            eq(approvals.stageInstanceId, stageInstanceId)
          )
        )
        .orderBy(desc(approvals.createdAt), desc(approvals.id))
        .limit(1);
      if ((latestApproval?.id ?? null) !== expectedApprovalId) return;
    }
    await transaction
      .update(stageInstances)
      .set({ status: 'CANCELLED', completedAt: now, updatedAt: now })
      .where(
        and(
          eq(stageInstances.organisationId, organisationId),
          eq(stageInstances.id, stageInstanceId),
          eq(stageInstances.status, 'QUEUED')
        )
      );
    if (
      reason === 'SOURCE_CHANGED' ||
      reason === 'APPROVAL_REQUIRED' ||
      reason === 'REMINDER_WHITELISTED'
    ) {
      await transaction
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
  });
};

const createOperatorTask = async (
  database: Database,
  input: {
    organisationId: string;
    contactId: string;
    invoiceId: string;
    sequenceId: string;
    summary: string;
    now: Date;
  }
): Promise<void> => {
  await database.insert(tasks).values({
    organisationId: input.organisationId,
    contactId: input.contactId,
    invoiceId: input.invoiceId,
    sequenceId: input.sequenceId,
    kind: 'MESSAGE_SEND_REVIEW',
    status: 'OPEN',
    dueAt: input.now,
    summary: input.summary,
    updatedAt: input.now
  });
};

const isKnownRejection = (error: unknown): boolean =>
  error instanceof SinchValidationFailure ||
  error instanceof SinchAuthenticationFailure ||
  error instanceof SinchPermanentSubmissionFailure ||
  error instanceof XeroEmailPermanentFailure ||
  error instanceof XeroRequestFailure ||
  error instanceof XeroTransientFailure;

export async function executeReminder(
  dependencies: ReminderExecutionDependencies,
  payload: JobPayloads['reminder.execute']
): Promise<ExecutionOutcome> {
  const now = dependencies.clock.now();
  const [stage] = await dependencies.database
    .select({
      channel: stageInstances.channel,
      sourceVersion: stageInstances.sourceVersion,
      status: stageInstances.status
    })
    .from(stageInstances)
    .where(
      and(
        eq(stageInstances.organisationId, payload.organisationId),
        eq(stageInstances.id, payload.stageInstanceId)
      )
    )
    .limit(1);
  if (stage === undefined || stage.channel === 'TASK') {
    throw new Error('Sendable reminder stage was not found');
  }
  const key = idempotencyKey(
    payload.stageInstanceId,
    stage.channel,
    stage.sourceVersion
  );
  const repository = new PostgresMessageRepository(dependencies.database);
  const existing = await repository.findOutcome(payload.organisationId, key);
  if (existing !== null) {
    return outcomeFromStored({
      status: existing.status,
      providerMessageId: existing.providerMessageId,
      channel: stage.channel
    });
  }
  if (stage.status !== 'QUEUED') {
    return { kind: 'cancelled', reason: 'UNSUPPORTED_SENDING_STATE' };
  }

  const validation = await revalidateReminder(
    {
      database: dependencies.database,
      xero: dependencies.xero,
      now
    },
    payload
  );
  if (validation.kind === 'blocked') {
    if (validation.reason === 'APPROVAL_REQUIRED') {
      return { kind: 'cancelled', reason: validation.reason };
    }
    await cancelStage(
      dependencies.database,
      payload.organisationId,
      payload.stageInstanceId,
      validation.reason,
      now,
      validation.approvalId
    );
    return { kind: 'cancelled', reason: validation.reason };
  }
  const reminder = validation.reminder;

  if (
    reminder.channel === 'XERO_EMAIL' &&
    !(await dependencies.xeroEmailAllowance.hasSafeHeadroom(
      payload.organisationId,
      now
    ))
  ) {
    await cancelStage(
      dependencies.database,
      payload.organisationId,
      payload.stageInstanceId,
      'XERO_EMAIL_ALLOWANCE',
      now
    );
    return { kind: 'cancelled', reason: 'XERO_EMAIL_ALLOWANCE' };
  }

  const contentHash = createHash('sha256')
    .update(reminder.content)
    .digest('hex');
  const source =
    reminder.channel === 'XERO_EMAIL'
      ? 'XERO_EMAIL'
      : reminder.stageOrigin === 'ESCALATION_SMS'
        ? 'ESCALATION_SMS'
        : reminder.stageOrigin === 'MANUAL_REMINDER'
          ? 'MANUAL_REMINDER'
          : 'AUTOMATED_REMINDER';
  const claim = await repository.beginReminder({
    organisationId: payload.organisationId,
    stageInstanceId: payload.stageInstanceId,
    contactId: reminder.contactId,
    invoiceId: reminder.invoiceId,
    ...(reminder.actorUserId === null
      ? {}
      : { actorUserId: reminder.actorUserId }),
    channel: reminder.channel,
    source,
    recipientKey: reminder.destination,
    sourceVersion: reminder.sourceVersion,
    content: reminder.content,
    contentHash,
    idempotencyKey: key,
    provider: reminder.channel === 'SMS' ? 'SINCH' : 'XERO',
    now
  });
  if (claim.kind === 'not-queued') {
    return { kind: 'cancelled', reason: 'UNSUPPORTED_SENDING_STATE' };
  }
  if (claim.kind === 'blocked') {
    await cancelStage(
      dependencies.database,
      payload.organisationId,
      payload.stageInstanceId,
      claim.reason,
      now
    );
    return { kind: 'cancelled', reason: claim.reason };
  }
  if (claim.kind === 'existing') {
    return outcomeFromStored({
      status: claim.outcome.status,
      providerMessageId: claim.outcome.providerMessageId,
      channel: reminder.channel
    });
  }

  let claimedDebtContactLocalDate: string | null = null;
  if (reminder.channel === 'SMS') {
    const contactAt = dependencies.clock.now();
    const scheduleValidation = await dependencies.database.transaction(
      (transaction) =>
        revalidateAutomaticReminderSchedule(
          { transaction, clock: dependencies.clock },
          {
            ...payload,
            expectedAutomatic:
              reminder.sequenceMode === 'AUTOMATIC' &&
              reminder.stageOrigin === 'AUTOMATION'
          }
        )
    );
    const [openDispute] = await dependencies.database
      .select({ id: disputes.id })
      .from(disputes)
      .where(
        and(
          eq(disputes.organisationId, payload.organisationId),
          eq(disputes.contactId, reminder.contactId),
          eq(disputes.status, 'OPEN'),
          or(
            isNull(disputes.invoiceId),
            eq(disputes.invoiceId, reminder.invoiceId)
          )
        )
      )
      .limit(1);
    const contactWindow = decideDebtContactWindow(
      contactAt,
      dependencies.holidays.list(payload.organisationId)
    );
    const blockBeforeProvider = async (
      reason:
        | 'DISPUTE_OPEN'
        | 'CONTACT_WINDOW_CLOSED'
        | 'DAILY_CONTACT_LIMIT'
        | 'OUTSIDE_SCHEDULE_WINDOW'
        | 'SOURCE_CHANGED'
    ): Promise<ExecutionOutcome> => {
      await markProviderSendBlocked(dependencies.database, {
        organisationId: payload.organisationId,
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: payload.stageInstanceId,
        reason,
        now: contactAt
      });
      return { kind: 'cancelled', reason };
    };
    if (scheduleValidation.kind === 'blocked') {
      return blockBeforeProvider(scheduleValidation.reason);
    }
    if (openDispute !== undefined) {
      return blockBeforeProvider('DISPUTE_OPEN');
    }
    if (!contactWindow.allowed) {
      return blockBeforeProvider('CONTACT_WINDOW_CLOSED');
    }
    const debtContactClaim = await new PostgresDebtContactRepository(
      dependencies.database
    ).claimDebtContact({
      organisationId: payload.organisationId,
      contactId: reminder.contactId,
      localDate: contactWindow.localDate,
      channel: 'SMS',
      sourceId: payload.stageInstanceId,
      claimedAt: contactAt
    });
    if (debtContactClaim.kind === 'already-claimed') {
      return blockBeforeProvider('DAILY_CONTACT_LIMIT');
    }
    claimedDebtContactLocalDate = contactWindow.localDate;
  }

  try {
    const sendResult = await dispatchWithProviderSendLock(
      dependencies.database,
      {
        organisationId: payload.organisationId,
        contactId: reminder.contactId,
        source,
        channel: reminder.channel,
        destination: reminder.destination,
        ...(reminder.channel === 'SMS'
          ? {
              outboundMessageId: claim.outboundId,
              smsPartCount: renderSms(reminder.content, {}, { maxSegments: 10 })
                .segmentCount
            }
          : {}),
        automatic:
          reminder.sequenceMode === 'AUTOMATIC' &&
          reminder.stageOrigin === 'AUTOMATION',
        now,
        clock: dependencies.clock
      },
      async (transaction, sendContext) => {
        const scheduleValidation = await revalidateAutomaticReminderSchedule(
          {
            transaction,
            clock: dependencies.clock
          },
          {
            ...payload,
            expectedAutomatic:
              reminder.sequenceMode === 'AUTOMATIC' &&
              reminder.stageOrigin === 'AUTOMATION'
          }
        );
        if (scheduleValidation.kind === 'blocked') {
          return {
            kind: 'schedule-blocked' as const,
            reason: scheduleValidation.reason,
            blockedAt: dependencies.clock.now()
          };
        }
        if (reminder.channel === 'SMS') {
          await sendContext.assertEntitlement();
          const contactAt = dependencies.clock.now();
          const [openDispute] = await transaction
            .select({ id: disputes.id })
            .from(disputes)
            .where(
              and(
                eq(disputes.organisationId, payload.organisationId),
                eq(disputes.contactId, reminder.contactId),
                eq(disputes.status, 'OPEN'),
                or(
                  isNull(disputes.invoiceId),
                  eq(disputes.invoiceId, reminder.invoiceId)
                )
              )
            )
            .limit(1);
          if (openDispute !== undefined) {
            return {
              kind: 'schedule-blocked' as const,
              reason: 'DISPUTE_OPEN' as const,
              blockedAt: contactAt
            };
          }
          const contactWindow = decideDebtContactWindow(
            contactAt,
            dependencies.holidays.list(payload.organisationId)
          );
          if (!contactWindow.allowed) {
            return {
              kind: 'schedule-blocked' as const,
              reason: 'CONTACT_WINDOW_CLOSED' as const,
              blockedAt: contactAt
            };
          }
          if (contactWindow.localDate !== claimedDebtContactLocalDate) {
            return {
              kind: 'schedule-blocked' as const,
              reason: 'DAILY_CONTACT_LIMIT' as const,
              blockedAt: contactAt
            };
          }
          const accepted = await dependencies.sinch.sendSms({
            destinationNumber: reminder.destination,
            ...(sendContext.smsSourceNumber === null
              ? {}
              : { sourceNumber: sendContext.smsSourceNumber }),
            content: reminder.content,
            callbackUrl: dependencies.callbackUrl,
            metadata: {
              organisationId: payload.organisationId,
              stageInstanceId: payload.stageInstanceId
            }
          });
          return {
            kind: 'accepted' as const,
            provider: 'SINCH' as const,
            providerMessageId: accepted.messageId,
            providerPayload: { status: accepted.status }
          };
        }

        await dependencies.xero.emailInvoice(reminder.xeroInvoiceId, () => sendContext.assertEntitlement());
        return {
          kind: 'accepted' as const,
          provider: 'XERO' as const,
          providerMessageId: null,
          providerPayload: { status: 'ACCEPTED' }
        };
      },
      (value) => value.kind !== 'schedule-blocked'
    );
    if (sendResult.kind === 'dry-run') {
      await repository.markDryRun({
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: payload.stageInstanceId,
        now
      });
      return { kind: 'dry-run' };
    }
    if (sendResult.kind === 'blocked') {
      await markProviderSendBlocked(dependencies.database, {
        organisationId: payload.organisationId,
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: payload.stageInstanceId,
        reason: sendResult.reason,
        now
      });
      return { kind: 'cancelled', reason: sendResult.reason };
    }
    if (sendResult.kind === 'suppressed') {
      await markProviderSendBlocked(dependencies.database, {
        organisationId: payload.organisationId,
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: payload.stageInstanceId,
        reason: 'CHANNEL_SUPPRESSED',
        now
      });
      return { kind: 'cancelled', reason: 'CHANNEL_SUPPRESSED' };
    }

    if (sendResult.value.kind === 'schedule-blocked') {
      await markProviderSendBlocked(dependencies.database, {
        organisationId: payload.organisationId,
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: payload.stageInstanceId,
        reason: sendResult.value.reason,
        now: sendResult.value.blockedAt
      });
      return { kind: 'cancelled', reason: sendResult.value.reason };
    }

    const accepted = sendResult.value;
    await repository.markAccepted({
      organisationId: payload.organisationId,
      stageInstanceId: payload.stageInstanceId,
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      ...(accepted.providerMessageId === null
        ? {}
        : { providerMessageId: accepted.providerMessageId }),
      providerPayload: accepted.providerPayload,
      now
    });
    return {
      kind: 'sent',
      provider: accepted.provider,
      providerMessageId: accepted.providerMessageId
    };
  } catch (error) {
    const rateLimited =
      error instanceof SinchRateLimited || error instanceof XeroRateLimited;
    if (rateLimited || isKnownRejection(error)) {
      if (reminder.channel === 'SMS') {
        await releaseSmsUsageReservation(dependencies.database, {
          organisationId: payload.organisationId,
          outboundMessageId: claim.outboundId,
          now
        });
      }
      const reason = rateLimited ? 'RATE_LIMITED' : 'PROVIDER_REJECTED';
      await repository.markRejected({
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: payload.stageInstanceId,
        errorCode: reason,
        now
      });
      if (rateLimited) {
        await createOperatorTask(dependencies.database, {
          organisationId: payload.organisationId,
          contactId: reminder.contactId,
          invoiceId: reminder.invoiceId,
          sequenceId: reminder.sequenceId,
          summary: `Provider rate limit prevented reminder for ${reminder.invoiceNumber}`,
          now
        });
      }
      return { kind: 'rejected', reason };
    }

    if (error instanceof SinchUnknownSubmissionOutcome || error instanceof Error) {
      await repository.markUnknown({
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        stageInstanceId: payload.stageInstanceId,
        now
      });
      await createOperatorTask(dependencies.database, {
        organisationId: payload.organisationId,
        contactId: reminder.contactId,
        invoiceId: reminder.invoiceId,
        sequenceId: reminder.sequenceId,
        summary: `Confirm unknown send outcome for ${reminder.invoiceNumber}`,
        now
      });
      return { kind: 'unknown' };
    }
    throw error;
  }
}
