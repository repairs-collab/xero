import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import {
  decideDebtContactWindow,
  nextDebtContactOpening,
  renderSms
} from '@bc5000/domain';

import {
  approvals,
  auditEvents,
  type Database,
  type DbTransaction,
  disputes,
  messageAttempts,
  organisations,
  outboundMessages,
  PostgresDebtContactRepository,
  PostgresMessageRepository,
  stageInstances,
  tasks
} from '@bc5000/db';
import {
  SinchAuthenticationFailure,
  SinchPermanentSubmissionFailure,
  SinchRateLimited,
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
  preflightAutomaticReminderSchedule,
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
  | { kind: 'deferred'; scheduledAt: Date }
  | { kind: 'in-progress' };

const idempotencyKey = (
  stageInstanceId: string,
  channel: string,
  sourceVersion: number,
  scheduledAt: Date
): string => {
  const base = `${stageInstanceId}:${channel}:${sourceVersion.toString()}`;
  return channel === 'SMS' ? `${base}:${scheduledAt.toISOString()}` : base;
};

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

const nextAutomaticSmsAttemptAt = (
  now: Date,
  scheduledAt: Date,
  holidays: readonly string[]
): Date => {
  const currentWindow = decideDebtContactWindow(now, holidays);
  if (scheduledAt > now) {
    return decideDebtContactWindow(scheduledAt, holidays).allowed
      ? scheduledAt
      : nextDebtContactOpening(scheduledAt, holidays);
  }
  if (
    currentWindow.allowed &&
    decideDebtContactWindow(scheduledAt, holidays).localDate !==
      currentWindow.localDate
  ) {
    return now;
  }
  return nextDebtContactOpening(now, holidays);
};

const lockOrganisation = async (
  transaction: DbTransaction,
  organisationId: string
): Promise<void> => {
  const [organisation] = await transaction
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for('update')
    .limit(1);
  if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
};

const auditAutomaticSmsDeferral = async (
  transaction: DbTransaction,
  input: {
    organisationId: string;
    stageInstanceId: string;
    before: Date;
    scheduledAt: Date;
    reason: 'CONTACT_WINDOW_CLOSED' | 'OUTSIDE_SCHEDULE_WINDOW';
    now: Date;
  }
): Promise<void> => {
  await transaction.insert(auditEvents).values({
    organisationId: input.organisationId,
    eventType: 'AUTOMATIC_REMINDER_CONTACT_WINDOW_RESCHEDULED',
    entityType: 'STAGE_INSTANCE',
    entityId: input.stageInstanceId,
    beforeValue: { scheduledAt: input.before.toISOString() },
    afterValue: {
      scheduledAt: input.scheduledAt.toISOString(),
      reason: input.reason
    },
    occurredAt: input.now
  });
};

type AutomaticSmsDeferralDecision =
  | { kind: 'deferred'; scheduledAt: Date }
  | { kind: 'eligible'; checkedAt: Date }
  | { kind: 'blocked'; reason: 'SOURCE_CHANGED' }
  | { kind: 'not-queued' };

const deferQueuedAutomaticSms = async (
  dependencies: ReminderExecutionDependencies,
  payload: JobPayloads['reminder.execute']
): Promise<AutomaticSmsDeferralDecision> =>
  dependencies.database.transaction(async (transaction) => {
    await lockOrganisation(transaction, payload.organisationId);
    const schedule = await revalidateAutomaticReminderSchedule(
      { transaction, clock: dependencies.clock },
      { ...payload, expectedAutomatic: true }
    );
    if (schedule.kind === 'blocked' && schedule.reason === 'SOURCE_CHANGED') {
      return { kind: 'blocked', reason: 'SOURCE_CHANGED' } as const;
    }
    if (schedule.scheduledAt === null) {
      return { kind: 'blocked', reason: 'SOURCE_CHANGED' } as const;
    }
    const checkedAt = dependencies.clock.now();
    const window = decideDebtContactWindow(
      checkedAt,
      dependencies.holidays.list(payload.organisationId)
    );
    if (schedule.kind === 'eligible' && window.allowed) {
      return { kind: 'eligible', checkedAt } as const;
    }
    const reason =
      schedule.kind === 'blocked'
        ? ('OUTSIDE_SCHEDULE_WINDOW' as const)
        : ('CONTACT_WINDOW_CLOSED' as const);
    const scheduledAt = nextAutomaticSmsAttemptAt(
      checkedAt,
      schedule.scheduledAt,
      dependencies.holidays.list(payload.organisationId)
    );
    const [deferred] = await transaction
      .update(stageInstances)
      .set({
        status: 'SCHEDULED',
        scheduledAt,
        completedAt: null,
        updatedAt: checkedAt
      })
      .where(
        and(
          eq(stageInstances.organisationId, payload.organisationId),
          eq(stageInstances.id, payload.stageInstanceId),
          eq(stageInstances.status, 'QUEUED')
        )
      )
      .returning({ id: stageInstances.id });
    if (deferred === undefined) return { kind: 'not-queued' } as const;
    await auditAutomaticSmsDeferral(transaction, {
      organisationId: payload.organisationId,
      stageInstanceId: payload.stageInstanceId,
      before: schedule.scheduledAt,
      scheduledAt,
      reason,
      now: checkedAt
    });
    return { kind: 'deferred', scheduledAt } as const;
  });

const writeClaimedAutomaticSmsDeferral = async (
  transaction: DbTransaction,
  input: {
    organisationId: string;
    stageInstanceId: string;
    outboundId: string;
    attemptId: string;
    before: Date;
    scheduledAt: Date;
    reason: 'CONTACT_WINDOW_CLOSED' | 'OUTSIDE_SCHEDULE_WINDOW';
    now: Date;
  }
): Promise<void> => {
  await transaction
    .update(messageAttempts)
    .set({
      status: 'CANCELLED',
      errorCode: input.reason,
      responseReceivedAt: input.now
    })
    .where(
      and(
        eq(messageAttempts.organisationId, input.organisationId),
        eq(messageAttempts.id, input.attemptId)
      )
    );
  await transaction
    .update(outboundMessages)
    .set({
      status: 'CANCELLED',
      failureReason: input.reason,
      completedAt: input.now,
      updatedAt: input.now
    })
    .where(
      and(
        eq(outboundMessages.organisationId, input.organisationId),
        eq(outboundMessages.id, input.outboundId)
      )
    );
  await transaction
    .update(stageInstances)
    .set({
      status: 'SCHEDULED',
      scheduledAt: input.scheduledAt,
      completedAt: null,
      updatedAt: input.now
    })
    .where(
      and(
        eq(stageInstances.organisationId, input.organisationId),
        eq(stageInstances.id, input.stageInstanceId),
        eq(stageInstances.status, 'SENDING')
      )
    );
  await auditAutomaticSmsDeferral(transaction, input);
};

const deferClaimedAutomaticSms = async (
  dependencies: ReminderExecutionDependencies,
  payload: JobPayloads['reminder.execute'],
  claim: { outboundId: string; attemptId: string }
): Promise<AutomaticSmsDeferralDecision> =>
  dependencies.database.transaction(async (transaction) => {
    await lockOrganisation(transaction, payload.organisationId);
    const schedule = await revalidateAutomaticReminderSchedule(
      { transaction, clock: dependencies.clock },
      { ...payload, expectedAutomatic: true }
    );
    if (schedule.kind === 'blocked' && schedule.reason === 'SOURCE_CHANGED') {
      return { kind: 'blocked', reason: 'SOURCE_CHANGED' } as const;
    }
    if (schedule.scheduledAt === null) {
      return { kind: 'blocked', reason: 'SOURCE_CHANGED' } as const;
    }
    const checkedAt = dependencies.clock.now();
    const window = decideDebtContactWindow(
      checkedAt,
      dependencies.holidays.list(payload.organisationId)
    );
    if (schedule.kind === 'eligible' && window.allowed) {
      return { kind: 'eligible', checkedAt } as const;
    }
    const reason =
      schedule.kind === 'blocked'
        ? ('OUTSIDE_SCHEDULE_WINDOW' as const)
        : ('CONTACT_WINDOW_CLOSED' as const);
    const scheduledAt = nextAutomaticSmsAttemptAt(
      checkedAt,
      schedule.scheduledAt,
      dependencies.holidays.list(payload.organisationId)
    );
    await writeClaimedAutomaticSmsDeferral(transaction, {
      organisationId: payload.organisationId,
      stageInstanceId: payload.stageInstanceId,
      ...claim,
      before: schedule.scheduledAt,
      scheduledAt,
      reason,
      now: checkedAt
    });
    return { kind: 'deferred', scheduledAt } as const;
  });

export async function executeReminder(
  dependencies: ReminderExecutionDependencies,
  payload: JobPayloads['reminder.execute']
): Promise<ExecutionOutcome> {
  const now = dependencies.clock.now();
  const [stage] = await dependencies.database
    .select({
      channel: stageInstances.channel,
      scheduledAt: stageInstances.scheduledAt,
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
    stage.sourceVersion,
    stage.scheduledAt
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
  if (stage.channel === 'SMS') {
    const schedule = await preflightAutomaticReminderSchedule(
      { database: dependencies.database, now },
      payload
    );
    const window = decideDebtContactWindow(
      now,
      dependencies.holidays.list(payload.organisationId)
    );
    if (
      schedule.automatic &&
      ((schedule.kind === 'blocked' &&
        schedule.reason === 'OUTSIDE_SCHEDULE_WINDOW') ||
        !window.allowed)
    ) {
      const deferral = await deferQueuedAutomaticSms(dependencies, payload);
      if (deferral.kind === 'deferred') return deferral;
      if (deferral.kind === 'not-queued') {
        return { kind: 'cancelled', reason: 'UNSUPPORTED_SENDING_STATE' };
      }
      if (deferral.kind === 'blocked') {
        await cancelStage(
          dependencies.database,
          payload.organisationId,
          payload.stageInstanceId,
          deferral.reason,
          now
        );
        return { kind: 'cancelled', reason: deferral.reason };
      }
    }
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

  try {
    let claimedDebtContactLocalDate: string | null = null;
    if (reminder.channel === 'SMS') {
      let contactAt = dependencies.clock.now();
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
      let contactWindow = decideDebtContactWindow(
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
      if (openDispute !== undefined) {
        return await blockBeforeProvider('DISPUTE_OPEN');
      }
      if (
        !contactWindow.allowed &&
        reminder.sequenceMode === 'AUTOMATIC' &&
        reminder.stageOrigin === 'AUTOMATION'
      ) {
        const deferral = await deferClaimedAutomaticSms(
          dependencies,
          payload,
          claim
        );
        if (deferral.kind === 'deferred') return deferral;
        if (deferral.kind === 'blocked') {
          return await blockBeforeProvider(deferral.reason);
        }
        if (deferral.kind === 'not-queued') {
          return await blockBeforeProvider('SOURCE_CHANGED');
        }
        contactAt = deferral.checkedAt;
        contactWindow = decideDebtContactWindow(
          contactAt,
          dependencies.holidays.list(payload.organisationId)
        );
      }
      if (!contactWindow.allowed) {
        return await blockBeforeProvider('CONTACT_WINDOW_CLOSED');
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
        return await blockBeforeProvider('DAILY_CONTACT_LIMIT');
      }
      claimedDebtContactLocalDate = contactWindow.localDate;
    }

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
          if (
            reminder.channel === 'SMS' &&
            reminder.sequenceMode === 'AUTOMATIC' &&
            reminder.stageOrigin === 'AUTOMATION' &&
            scheduleValidation.reason === 'OUTSIDE_SCHEDULE_WINDOW' &&
            scheduleValidation.scheduledAt !== null
          ) {
            const deferredAt = dependencies.clock.now();
            const scheduledAt = nextAutomaticSmsAttemptAt(
              deferredAt,
              scheduleValidation.scheduledAt,
              dependencies.holidays.list(payload.organisationId)
            );
            await writeClaimedAutomaticSmsDeferral(transaction, {
              organisationId: payload.organisationId,
              stageInstanceId: payload.stageInstanceId,
              outboundId: claim.outboundId,
              attemptId: claim.attemptId,
              before: scheduleValidation.scheduledAt,
              scheduledAt,
              reason: 'OUTSIDE_SCHEDULE_WINDOW',
              now: deferredAt
            });
            return { kind: 'deferred' as const, scheduledAt };
          }
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
            if (
              reminder.sequenceMode === 'AUTOMATIC' &&
              reminder.stageOrigin === 'AUTOMATION'
            ) {
              const scheduledAt = nextAutomaticSmsAttemptAt(
                contactAt,
                scheduleValidation.scheduledAt,
                dependencies.holidays.list(payload.organisationId)
              );
              await writeClaimedAutomaticSmsDeferral(transaction, {
                organisationId: payload.organisationId,
                stageInstanceId: payload.stageInstanceId,
                outboundId: claim.outboundId,
                attemptId: claim.attemptId,
                before: scheduleValidation.scheduledAt,
                scheduledAt,
                reason: 'CONTACT_WINDOW_CLOSED',
                now: contactAt
              });
              return { kind: 'deferred' as const, scheduledAt };
            }
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
      (value) =>
        value.kind !== 'schedule-blocked' && value.kind !== 'deferred'
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

    if (sendResult.value.kind === 'deferred') return sendResult.value;

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
}
