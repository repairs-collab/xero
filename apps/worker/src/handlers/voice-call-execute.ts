import { createHash } from 'node:crypto';

import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  or
} from 'drizzle-orm';

import {
  auditEvents,
  contactChannels,
  contacts,
  disputes,
  type Database,
  invoiceChases,
  invoices,
  memberships,
  organisations,
  organisationVoiceSettings,
  pauses,
  paymentPromises,
  type PostgresVoiceCallRepository,
  reminderSequences,
  reminderWhitelistEntries,
  suppressions,
  users,
  voiceCallRequests
} from '@bc5000/db';
import {
  buildVoiceCallDetailVariables,
  evaluateVoiceContactPolicy,
  fixedVoiceCallCopy,
  normaliseVoiceAmount,
  type VoiceCallOperationalState,
  type VoicePolicyBlockCode
} from '@bc5000/domain';
import {
  RetellAuthenticationError,
  type RetellCreatePhoneCallInput,
  RetellPermanentError,
  RetellRateLimitedError,
  RetellTransientError,
  RetellUnknownDispatchError
} from '@bc5000/integrations/retell';
import {
  jobNames,
  type JobPublisher,
  type VoiceCallExecutePayload
} from '@bc5000/jobs';

export interface VoiceCallProvider {
  createPhoneCall(
    input: RetellCreatePhoneCallInput
  ): Promise<{ callId: string; callStatus: string }>;
}

export interface VoiceCallExecutionDependencies {
  database: Database;
  repository: PostgresVoiceCallRepository;
  clock: { now(): Date };
  secrets: { read(reference: string): Promise<string> };
  providerFactory: { create(apiKey: string): VoiceCallProvider };
  publisher: JobPublisher;
  holidays: { list(organisationId: string): readonly string[] };
}

export type VoiceCallCancellationCode =
  | VoicePolicyBlockCode
  | 'VOICE_CALL_NOT_FOUND'
  | 'INITIATING_USER_DISABLED'
  | 'UNKNOWN_OUTCOME'
  | 'STALE_ACCOUNT_DATA';

export type VoiceCallExecutionResult =
  | { kind: 'accepted'; providerCallId: string }
  | { kind: 'existing'; state: VoiceCallOperationalState }
  | { kind: 'cancelled'; reason: VoiceCallCancellationCode }
  | { kind: 'failed'; reason: 'PROVIDER_REJECTED' }
  | { kind: 'unknown' };

const currentCallFlowHash = `sha256:${createHash('sha256')
  .update(JSON.stringify(fixedVoiceCallCopy))
  .digest('hex')}`;

const canonicalDecimal = (value: string): string | null => {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (match === null) return null;
  const integer = (match[2] ?? '').replace(/^0+(?=\d)/, '') || '0';
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const zero = integer === '0' && fraction === '';
  const sign = match[1] === '-' && !zero ? '-' : '';
  return `${sign}${integer}${fraction === '' ? '' : `.${fraction}`}`;
};

const decimalValuesEqual = (left: string, right: string): boolean => {
  const canonicalLeft = canonicalDecimal(left);
  return canonicalLeft !== null && canonicalLeft === canonicalDecimal(right);
};

const decimalIsPositive = (value: string): boolean => {
  const canonical = canonicalDecimal(value);
  return canonical !== null && canonical !== '0' && !canonical.startsWith('-');
};

const localDate = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const promiseIsActive = (
  promise: { promisedDate: string; graceDays: number },
  today: string
): boolean => {
  const end = new Date(`${promise.promisedDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + promise.graceDays);
  return end.toISOString().slice(0, 10) >= today;
};

const audit = async (
  database: Database,
  input: {
    organisationId: string;
    actorUserId: string | null;
    voiceCallId: string;
    correlationId?: string;
    eventType: string;
    state: VoiceCallOperationalState;
    safeCode?: string;
    occurredAt: Date;
  }
): Promise<void> => {
  await database.insert(auditEvents).values({
    organisationId: input.organisationId,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    entityType: 'VOICE_CALL',
    entityId: input.voiceCallId,
    correlationId: input.correlationId,
    afterValue: {
      state: input.state,
      ...(input.safeCode === undefined ? {} : { safeCode: input.safeCode })
    },
    occurredAt: input.occurredAt
  });
};

const cancel = async (
  dependencies: VoiceCallExecutionDependencies,
  payload: VoiceCallExecutePayload,
  actorUserId: string | null,
  reason: VoiceCallCancellationCode,
  now: Date
): Promise<VoiceCallExecutionResult> => {
  await dependencies.database
    .update(voiceCallRequests)
    .set({
      state: 'CANCELLED',
      failureCode: reason,
      completedAt: now,
      updatedAt: now
    })
    .where(
      and(
        eq(voiceCallRequests.organisationId, payload.organisationId),
        eq(voiceCallRequests.id, payload.voiceCallId),
        eq(voiceCallRequests.state, 'QUEUED')
      )
    );
  await audit(dependencies.database, {
    organisationId: payload.organisationId,
    actorUserId,
    voiceCallId: payload.voiceCallId,
    ...(payload.correlationId === undefined
      ? {}
      : { correlationId: payload.correlationId }),
    eventType: 'VOICE_CALL_CANCELLED',
    state: 'CANCELLED',
    safeCode: reason,
    occurredAt: now
  });
  return { kind: 'cancelled', reason };
};

interface RevalidatedCall {
  call: NonNullable<
    Awaited<ReturnType<PostgresVoiceCallRepository['loadForExecution']>>
  >;
  settings: typeof organisationVoiceSettings.$inferSelect;
}

const revalidate = async (
  dependencies: VoiceCallExecutionDependencies,
  payload: VoiceCallExecutePayload,
  now: Date
): Promise<
  | { kind: 'eligible'; value: RevalidatedCall }
  | {
      kind: 'blocked';
      actorUserId: string | null;
      reason: VoiceCallCancellationCode;
    }
  | { kind: 'existing'; state: VoiceCallOperationalState }
> => {
  const call = await dependencies.repository.loadForExecution(
    payload.organisationId,
    payload.voiceCallId
  );
  if (call === null) {
    return {
      kind: 'blocked',
      actorUserId: null,
      reason: 'VOICE_CALL_NOT_FOUND'
    };
  }
  if (call.state !== 'QUEUED') return { kind: 'existing', state: call.state };

  const [organisationRows, settingsRows, contactRows, actorRows] =
    await Promise.all([
      dependencies.database
        .select()
        .from(organisations)
        .where(eq(organisations.id, payload.organisationId))
        .limit(1),
      dependencies.database
        .select()
        .from(organisationVoiceSettings)
        .where(
          eq(organisationVoiceSettings.organisationId, payload.organisationId)
        )
        .limit(1),
      dependencies.database
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.organisationId, payload.organisationId),
            eq(contacts.id, call.contactId)
          )
        )
        .limit(1),
      call.actorUserId === null
        ? Promise.resolve([])
        : dependencies.database
            .select({
              membershipDisabledAt: memberships.disabledAt,
              userDisabledAt: users.disabledAt
            })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(memberships.organisationId, payload.organisationId),
                eq(memberships.userId, call.actorUserId)
              )
            )
            .limit(1)
    ]);
  const organisation = organisationRows[0];
  const settings = settingsRows[0];
  const contact = contactRows[0];
  const actor = actorRows[0];
  if (
    organisation === undefined ||
    settings === undefined ||
    contact === undefined
  ) {
    return {
      kind: 'blocked',
      actorUserId: call.actorUserId,
      reason: 'STALE_ACCOUNT_DATA'
    };
  }
  if (
    call.actorUserId === null ||
    actor === undefined ||
    actor.membershipDisabledAt !== null ||
    actor.userDisabledAt !== null
  ) {
    return {
      kind: 'blocked',
      actorUserId: call.actorUserId,
      reason: 'INITIATING_USER_DISABLED'
    };
  }

  const currentInvoices =
    call.invoices.length === 0
      ? []
      : await dependencies.database
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.organisationId, payload.organisationId),
              eq(invoices.contactId, call.contactId),
              inArray(
                invoices.id,
                call.invoices.map((invoice) => invoice.invoiceId)
              )
            )
          );
  const invoiceById = new Map(
    currentInvoices.map((invoice) => [invoice.id, invoice])
  );
  const sourcesChanged =
    currentInvoices.length !== call.invoices.length ||
    call.invoices.some((snapshot) => {
      const source = invoiceById.get(snapshot.invoiceId);
      return (
        source === undefined ||
        source.xeroInvoiceId !== snapshot.xeroInvoiceId ||
        source.invoiceNumber !== snapshot.invoiceNumber ||
        !decimalValuesEqual(source.amountDue, snapshot.amountDue) ||
        source.currency !== snapshot.currency ||
        source.dueDate !== snapshot.dueDate ||
        source.syncVersion !== snapshot.syncVersion ||
        source.contactId !== call.contactId ||
        source.type !== 'ACCREC' ||
        source.status !== 'AUTHORISED' ||
        !decimalIsPositive(source.amountDue)
      );
    });
  const settingsChanged =
    settings.agentId !== call.agentId ||
    settings.agentVersion !== call.agentVersion ||
    settings.voiceId !== call.voiceId ||
    settings.outboundNumber !== call.outboundNumber ||
    settings.officeDestinationLabel !== call.transferTargetLabel ||
    settings.updatedAt.getTime() !== call.voiceSettingsUpdatedAt.getTime() ||
    call.callFlowVersion !== fixedVoiceCallCopy.version ||
    call.callFlowHash !== currentCallFlowHash;
  if (sourcesChanged || settingsChanged || !contact.active) {
    return {
      kind: 'blocked',
      actorUserId: call.actorUserId,
      reason: 'STALE_ACCOUNT_DATA'
    };
  }

  const invoiceIds = call.invoices.map((invoice) => invoice.invoiceId);
  const chaseRows = await dependencies.database
    .select({
      invoiceId: invoiceChases.invoiceId,
      sequenceId: invoiceChases.sequenceId
    })
    .from(invoiceChases)
    .innerJoin(
      reminderSequences,
      and(
        eq(reminderSequences.id, invoiceChases.sequenceId),
        eq(reminderSequences.organisationId, payload.organisationId),
        eq(reminderSequences.enabled, true)
      )
    )
    .where(
      and(
        eq(invoiceChases.organisationId, payload.organisationId),
        eq(invoiceChases.customerId, call.contactId),
        eq(invoiceChases.status, 'ACTIVE'),
        inArray(invoiceChases.invoiceId, invoiceIds)
      )
    );
  const activeChaseIds = new Set(chaseRows.map((row) => row.invoiceId));
  if (invoiceIds.some((invoiceId) => !activeChaseIds.has(invoiceId))) {
    return {
      kind: 'blocked',
      actorUserId: call.actorUserId,
      reason: 'STALE_ACCOUNT_DATA'
    };
  }
  const sequenceIds = [...new Set(chaseRows.map((row) => row.sequenceId))];
  const [
    channels,
    suppressionsRows,
    disputesRows,
    promisesRows,
    pausesRows,
    whitelistRows
  ] =
    await Promise.all([
      dependencies.database
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.organisationId, payload.organisationId),
            eq(contactChannels.contactId, call.contactId),
            eq(contactChannels.kind, 'VOICE'),
            eq(contactChannels.usable, true)
          )
        ),
      dependencies.database
        .select()
        .from(suppressions)
        .where(
          and(
            eq(suppressions.organisationId, payload.organisationId),
            eq(suppressions.channel, 'VOICE'),
            eq(suppressions.normalisedDestination, call.destinationNumber),
            eq(suppressions.consentState, 'SUPPRESSED')
          )
        ),
      dependencies.database
        .select()
        .from(disputes)
        .where(
          and(
            eq(disputes.organisationId, payload.organisationId),
            eq(disputes.contactId, call.contactId),
            eq(disputes.status, 'OPEN'),
            or(isNull(disputes.invoiceId), inArray(disputes.invoiceId, invoiceIds))
          )
        ),
      dependencies.database
        .select()
        .from(paymentPromises)
        .where(
          and(
            eq(paymentPromises.organisationId, payload.organisationId),
            eq(paymentPromises.contactId, call.contactId),
            eq(paymentPromises.status, 'ACTIVE')
          )
        ),
      dependencies.database
        .select()
        .from(pauses)
        .where(
          and(
            eq(pauses.organisationId, payload.organisationId),
            eq(pauses.active, true),
            or(isNull(pauses.expiresAt), gt(pauses.expiresAt, now)),
            or(
              eq(pauses.contactId, call.contactId),
              inArray(pauses.invoiceId, invoiceIds),
              inArray(pauses.sequenceId, sequenceIds)
            )
          )
        ),
      dependencies.database
        .select()
        .from(reminderWhitelistEntries)
        .where(
          and(
            eq(reminderWhitelistEntries.organisationId, payload.organisationId),
            eq(reminderWhitelistEntries.contactId, call.contactId),
            isNull(reminderWhitelistEntries.removedAt),
            or(
              eq(reminderWhitelistEntries.scope, 'CLIENT'),
              inArray(reminderWhitelistEntries.invoiceId, invoiceIds)
            )
          )
        ),
    ]);
  const destinationIsCurrent = channels.some(
    (channel) => channel.normalisedValue === call.destinationNumber
  );
  if (!destinationIsCurrent) {
    return {
      kind: 'blocked',
      actorUserId: call.actorUserId,
      reason: 'STALE_ACCOUNT_DATA'
    };
  }

  const attempts = await dependencies.repository.recentProviderAcceptedAttempts({
    organisationId: payload.organisationId,
    contactId: call.contactId,
    from: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
    before: now
  });
  const today = localDate(now, settings.timezone);
  const policy = evaluateVoiceContactPolicy({
    now,
    timezone: settings.timezone,
    holidays: [...dependencies.holidays.list(payload.organisationId)],
    weekdayStartLocal: settings.weekdayStartLocal.slice(0, 5),
    weekdayEndLocal: settings.weekdayEndLocal.slice(0, 5),
    featureEnabled: settings.enabled,
    permissionAllowed: true,
    destinationValid: destinationIsCurrent,
    voiceSuppressed: suppressionsRows.length > 0,
    disputeOpen: disputesRows.length > 0,
    promiseToPayActive: promisesRows.some((promise) =>
      promiseIsActive(promise, today)
    ),
    paused: pausesRows.length > 0,
    whitelisted: whitelistRows.length > 0,
    staleAccountData:
      organisation.maintenanceMode ||
      !['READY', 'RECONCILED'].includes(organisation.operationalState) ||
      organisation.lastSuccessfulSyncAt === null,
    organisationCallInFlight: false,
    attempts,
    includedInvoiceIds: invoiceIds,
    excludedInvoices: []
  });
  if (!policy.allowed) {
    return {
      kind: 'blocked',
      actorUserId: call.actorUserId,
      reason: policy.blockCode ?? 'STALE_ACCOUNT_DATA'
    };
  }

  return { kind: 'eligible', value: { call, settings } };
};

const knownProviderFailure = (error: unknown): boolean =>
  error instanceof RetellPermanentError ||
  error instanceof RetellAuthenticationError ||
  error instanceof RetellRateLimitedError ||
  error instanceof RetellTransientError;

const queueReconciliation = async (
  dependencies: VoiceCallExecutionDependencies,
  payload: VoiceCallExecutePayload
): Promise<void> => {
  await dependencies.publisher.publish(
    jobNames.voiceCallReconcile,
    {
      organisationId: payload.organisationId,
      voiceCallId: payload.voiceCallId,
      ...(payload.correlationId === undefined
        ? {}
        : { correlationId: payload.correlationId })
    },
    { singletonKey: `voice-call-reconcile:${payload.voiceCallId}` }
  );
};

export async function executeVoiceCall(
  dependencies: VoiceCallExecutionDependencies,
  payload: VoiceCallExecutePayload
): Promise<VoiceCallExecutionResult> {
  const now = dependencies.clock.now();
  const validation = await revalidate(dependencies, payload, now);
  if (validation.kind === 'existing') {
    if (validation.state === 'UNKNOWN') {
      await queueReconciliation(dependencies, payload);
    }
    return { kind: 'existing', state: validation.state };
  }
  if (validation.kind === 'blocked') {
    return cancel(
      dependencies,
      payload,
      validation.actorUserId,
      validation.reason,
      now
    );
  }

  const { call, settings } = validation.value;
  const apiKey = await dependencies.secrets.read(settings.secretReference);
  const provider = dependencies.providerFactory.create(apiKey);

  const claim = await dependencies.repository.claimForSubmission({
    organisationId: payload.organisationId,
    voiceCallId: payload.voiceCallId,
    now
  });
  if (claim.kind === 'existing') {
    if (claim.state === 'UNKNOWN') {
      await queueReconciliation(dependencies, payload);
    }
    return { kind: 'existing', state: claim.state };
  }
  if (claim.kind === 'blocked') {
    return cancel(
      dependencies,
      payload,
      validation.value.call.actorUserId,
      claim.reason,
      now
    );
  }

  const detailVariables = buildVoiceCallDetailVariables({
    callbackNumber: settings.fallbackOfficeNumber,
    combinedAmount: call.combinedAmount,
    currency: call.currency,
    invoices: call.invoices.map((invoice) => ({
      invoiceNumber: invoice.invoiceNumber,
      amountDue: invoice.amountDue,
      dueDate: invoice.dueDate
    }))
  });
  try {
    const result = await provider.createPhoneCall({
      fromNumber: call.outboundNumber,
      toNumber: call.destinationNumber,
      idempotencyKey: call.idempotencyKey,
      agentId: call.agentId,
      agentVersion: call.agentVersion,
      dynamicVariables: {
        accountpulse_call_id: call.id,
        invoice_details_json: JSON.stringify(detailVariables.invoices),
        combined_amount: normaliseVoiceAmount(detailVariables.combinedAmount),
        currency: detailVariables.currency,
        callback_number: detailVariables.callbackNumber,
        fallback_office_number: settings.fallbackOfficeNumber,
        ...(settings.transferSipUri === null
          ? {}
          : { transfer_sip_uri: settings.transferSipUri })
      },
      metadata: {
        organisation_id: payload.organisationId,
        voice_call_id: call.id
      }
    });
    await dependencies.repository.recordProviderAccepted({
      organisationId: payload.organisationId,
      voiceCallId: call.id,
      providerCallId: result.callId,
      now
    });
    await audit(dependencies.database, {
      organisationId: payload.organisationId,
      actorUserId: call.actorUserId,
      voiceCallId: call.id,
      ...(payload.correlationId === undefined
        ? {}
        : { correlationId: payload.correlationId }),
      eventType: 'VOICE_CALL_PROVIDER_ACCEPTED',
      state: 'ACCEPTED',
      occurredAt: now
    });
    return { kind: 'accepted', providerCallId: result.callId };
  } catch (error) {
    if (error instanceof RetellUnknownDispatchError) {
      await dependencies.database
        .update(voiceCallRequests)
        .set({
          state: 'UNKNOWN',
          failureCode: 'DISPATCH_OUTCOME_UNKNOWN',
          updatedAt: now
        })
        .where(
          and(
            eq(voiceCallRequests.organisationId, payload.organisationId),
            eq(voiceCallRequests.id, call.id),
            eq(voiceCallRequests.state, 'SUBMITTING')
          )
        );
      await queueReconciliation(dependencies, payload);
      await audit(dependencies.database, {
        organisationId: payload.organisationId,
        actorUserId: call.actorUserId,
        voiceCallId: call.id,
        ...(payload.correlationId === undefined
          ? {}
          : { correlationId: payload.correlationId }),
        eventType: 'VOICE_CALL_OUTCOME_UNKNOWN',
        state: 'UNKNOWN',
        safeCode: 'DISPATCH_OUTCOME_UNKNOWN',
        occurredAt: now
      });
      return { kind: 'unknown' };
    }
    if (knownProviderFailure(error)) {
      await dependencies.database
        .update(voiceCallRequests)
        .set({
          state: 'FAILED',
          outcome: 'PROVIDER_REJECTED',
          failureCode: 'PROVIDER_REJECTED',
          completedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(voiceCallRequests.organisationId, payload.organisationId),
            eq(voiceCallRequests.id, call.id),
            eq(voiceCallRequests.state, 'SUBMITTING')
          )
        );
      await audit(dependencies.database, {
        organisationId: payload.organisationId,
        actorUserId: call.actorUserId,
        voiceCallId: call.id,
        ...(payload.correlationId === undefined
          ? {}
          : { correlationId: payload.correlationId }),
        eventType: 'VOICE_CALL_FAILED',
        state: 'FAILED',
        safeCode: 'PROVIDER_REJECTED',
        occurredAt: now
      });
      return { kind: 'failed', reason: 'PROVIDER_REJECTED' };
    }
    throw error;
  }
}
