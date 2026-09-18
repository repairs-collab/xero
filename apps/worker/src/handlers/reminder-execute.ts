import { createHash } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import {
  approvals,
  type Database,
  PostgresMessageRepository,
  stageInstances,
  tasks
} from '@bc5000/db';
import {
  SinchAuthenticationFailure,
  SinchPermanentSubmissionFailure,
  SinchRateLimited,
  SinchTransientFailure,
  SinchUnknownSubmissionOutcome,
  SinchValidationFailure,
  type SinchSendSmsInput,
  type SinchSubmitResult
} from '@bc5000/integrations/sinch';
import {
  XeroEmailPermanentFailure,
  XeroRateLimited,
  XeroRequestFailure,
  XeroTransientFailure
} from '@bc5000/integrations/xero';
import type { JobPayloads } from '@bc5000/jobs';

import {
  revalidateReminder,
  type RevalidationXeroClient,
  type StopReason
} from '../services/pre-send-revalidation.js';

export interface ReminderExecutionClock {
  now(): Date;
}

export interface ReminderExecutionXero extends RevalidationXeroClient {
  emailInvoice(invoiceId: string): Promise<{ kind: 'accepted' }>;
}

export interface ReminderExecutionSinch {
  sendSms(input: SinchSendSmsInput): Promise<SinchSubmitResult>;
}

export interface XeroEmailAllowance {
  hasSafeHeadroom(organisationId: string, now: Date): Promise<boolean>;
}

export interface ReminderExecutionDependencies {
  database: Database;
  clock: ReminderExecutionClock;
  xero: ReminderExecutionXero;
  sinch: ReminderExecutionSinch;
  callbackUrl: string;
  xeroEmailAllowance: XeroEmailAllowance;
}

export type ExecutionOutcome =
  | {
      kind: 'sent';
      provider: 'SINCH' | 'XERO';
      providerMessageId: string | null;
    }
  | { kind: 'dry-run' }
  | { kind: 'cancelled'; reason: StopReason | 'XERO_EMAIL_ALLOWANCE' }
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
  now: Date
): Promise<void> => {
  await database.transaction(async (transaction) => {
    await transaction
      .update(stageInstances)
      .set({ status: 'CANCELLED', completedAt: now, updatedAt: now })
      .where(
        and(
          eq(stageInstances.organisationId, organisationId),
          eq(stageInstances.id, stageInstanceId)
        )
      );
    if (reason === 'SOURCE_CHANGED' || reason === 'APPROVAL_REQUIRED') {
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
  error instanceof SinchTransientFailure ||
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
      sourceVersion: stageInstances.sourceVersion
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

  const validation = await revalidateReminder(
    {
      database: dependencies.database,
      xero: dependencies.xero,
      now
    },
    payload
  );
  if (validation.kind === 'blocked') {
    await cancelStage(
      dependencies.database,
      payload.organisationId,
      payload.stageInstanceId,
      validation.reason,
      now
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
  const claim = await repository.begin({
    organisationId: payload.organisationId,
    stageInstanceId: payload.stageInstanceId,
    channel: reminder.channel,
    recipientKey: reminder.destination,
    sourceVersion: reminder.sourceVersion,
    contentHash,
    idempotencyKey: key,
    provider: reminder.channel === 'SMS' ? 'SINCH' : 'XERO',
    now
  });
  if (claim.kind === 'existing') {
    return outcomeFromStored({
      status: claim.outcome.status,
      providerMessageId: claim.outcome.providerMessageId,
      channel: reminder.channel
    });
  }

  const liveAllowed =
    reminder.sendMode === 'live' &&
    reminder.liveSendAcknowledged &&
    reminder.recipientAllowlist.includes(reminder.destination);
  if (!liveAllowed) {
    await repository.markDryRun({
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      stageInstanceId: payload.stageInstanceId,
      now
    });
    return { kind: 'dry-run' };
  }

  try {
    if (reminder.channel === 'SMS') {
      const accepted = await dependencies.sinch.sendSms({
        destinationNumber: reminder.destination,
        content: reminder.content,
        callbackUrl: dependencies.callbackUrl,
        metadata: {
          organisationId: payload.organisationId,
          stageInstanceId: payload.stageInstanceId
        }
      });
      await repository.markAccepted({
        organisationId: payload.organisationId,
        stageInstanceId: payload.stageInstanceId,
        outboundId: claim.outboundId,
        attemptId: claim.attemptId,
        providerMessageId: accepted.messageId,
        providerPayload: { status: accepted.status },
        now
      });
      return {
        kind: 'sent',
        provider: 'SINCH',
        providerMessageId: accepted.messageId
      };
    }

    await dependencies.xero.emailInvoice(reminder.xeroInvoiceId);
    await repository.markAccepted({
      organisationId: payload.organisationId,
      stageInstanceId: payload.stageInstanceId,
      outboundId: claim.outboundId,
      attemptId: claim.attemptId,
      providerPayload: { status: 'ACCEPTED' },
      now
    });
    return { kind: 'sent', provider: 'XERO', providerMessageId: null };
  } catch (error) {
    const rateLimited =
      error instanceof SinchRateLimited || error instanceof XeroRateLimited;
    if (rateLimited || isKnownRejection(error)) {
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
