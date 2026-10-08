import { createHash } from 'node:crypto';

import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or
} from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  contactChannels,
  contacts,
  disputes,
  invoiceChases,
  invoices,
  organisations,
  organisationVoiceSettings,
  pauses,
  paymentPromises,
  reminderSequences,
  reminderWhitelistEntries,
  suppressions,
  voiceCallRequests,
  type Database,
  type PostgresVoiceCallRepository
} from '@bc5000/db/web';
import {
  buildCombinedVoiceDraft,
  evaluateVoiceContactPolicy,
  fixedVoiceCallCopy,
  normaliseVoiceAmount,
  type VoiceDraftExcludedInvoice,
  type VoicePolicyBlockCode
} from '@bc5000/domain';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export interface PrepareVoiceCallInput {
  organisationId: string;
  customerId: string;
  idempotencyKey: string;
}

export interface ApproveAndQueueVoiceCallInput
  extends PrepareVoiceCallInput {
  voiceCallId: string;
  callFlowVersion: number;
  callFlowHash: string;
  approvedFactsHash: string;
  confirmed: boolean;
}

export interface ApprovedVoiceInvoiceFact {
  invoiceId: string;
  xeroInvoiceId: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  dueDate: string;
  syncVersion: number;
}

export interface ApprovedVoiceFacts {
  accountName: string;
  destinationNumber: string;
  outboundNumber: string;
  combinedAmount: string;
  currency: string;
  agentId: string;
  agentVersion: number;
  voiceId: string;
  voipcloudUserNumber: string;
  ttsVoiceId: string;
  gatewayFlowVersion: number;
  voiceSettingsUpdatedAt: string;
  transferTargetLabel: string;
  callFlowVersion: number;
  callFlowHash: string;
  invoices: ApprovedVoiceInvoiceFact[];
}

export interface VoiceCallDraftView {
  voiceCallId: string | null;
  idempotencyKey: string;
  allowed: boolean;
  blockCode: VoicePolicyBlockCode | null;
  customerId: string;
  customerName: string;
  destinationNumber: string | null;
  destinationSource: string | null;
  outboundNumber: string | null;
  callerIdentityLabel: string | null;
  transferTargetLabel: string | null;
  combinedAmount: string;
  currency: string;
  includedInvoices: ApprovedVoiceInvoiceFact[];
  excludedInvoices: VoiceDraftExcludedInvoice[];
  attemptsLastSevenDays: number;
  attemptsThisMonth: number;
  nextPermittedAt: Date | null;
  callFlowVersion: number;
  callFlowHash: string;
  approvedFacts: ApprovedVoiceFacts | null;
  approvedFactsHash: string | null;
}

export interface VoiceCallServiceDependencies {
  database: Database;
  repository: PostgresVoiceCallRepository;
  publisher: JobPublisher;
  session: AppSession;
  clock: { now(): Date };
  holidays: { list(organisationId: string): readonly string[] };
}

const flowHash = `sha256:${createHash('sha256')
  .update(JSON.stringify(fixedVoiceCallCopy))
  .digest('hex')}`;

const validVoiceTypes = new Set([
  'FIXED_LINE',
  'MOBILE',
  'FIXED_LINE_OR_MOBILE',
  'VOIP'
]);

const normaliseVoiceNumber = (value: string): string | null => {
  const parsed = parsePhoneNumberFromString(value, 'AU');
  if (parsed === undefined || !parsed.isValid()) return null;
  const type = parsed.getType();
  return type === undefined || validVoiceTypes.has(type) ? parsed.number : null;
};

const localDate = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const localMonth = (date: Date, timezone: string): string =>
  localDate(date, timezone).slice(0, 7);

const canonicalFacts = (facts: ApprovedVoiceFacts): ApprovedVoiceFacts => ({
  ...facts,
  invoices: [...facts.invoices].sort(
    (left, right) =>
      left.dueDate.localeCompare(right.dueDate) ||
      left.invoiceNumber.localeCompare(right.invoiceNumber) ||
      left.invoiceId.localeCompare(right.invoiceId)
  )
});

export const buildApprovedVoiceFactsHash = (
  facts: ApprovedVoiceFacts
): string =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalFacts(facts)))
    .digest('hex')}`;

const snapshotFacts = (input: {
  accountName: string;
  destinationNumber: string;
  outboundNumber: string;
  combinedAmount: string;
  currency: string;
  agentId: string;
  agentVersion: number;
  voiceId: string;
  voipcloudUserNumber: string;
  ttsVoiceId: string;
  gatewayFlowVersion: number;
  voiceSettingsUpdatedAt: Date;
  transferTargetLabel: string;
  invoices: ApprovedVoiceInvoiceFact[];
}): ApprovedVoiceFacts =>
  canonicalFacts({
    accountName: input.accountName,
    destinationNumber: input.destinationNumber,
    outboundNumber: input.outboundNumber,
    combinedAmount: normaliseVoiceAmount(input.combinedAmount),
    currency: input.currency,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    voiceId: input.voiceId,
    voipcloudUserNumber: input.voipcloudUserNumber,
    ttsVoiceId: input.ttsVoiceId,
    gatewayFlowVersion: input.gatewayFlowVersion,
    voiceSettingsUpdatedAt: input.voiceSettingsUpdatedAt.toISOString(),
    transferTargetLabel: input.transferTargetLabel,
    callFlowVersion: fixedVoiceCallCopy.version,
    callFlowHash: flowHash,
    invoices: input.invoices.map((invoice) => ({
      ...invoice,
      amountDue: normaliseVoiceAmount(invoice.amountDue)
    }))
  });

const activePromise = (
  promise: { promisedDate: string; graceDays: number },
  today: string
): boolean => {
  const protectedUntil = new Date(`${promise.promisedDate}T00:00:00.000Z`);
  protectedUntil.setUTCDate(protectedUntil.getUTCDate() + promise.graceDays);
  return protectedUntil.toISOString().slice(0, 10) >= today;
};

export function createVoiceCallService(
  dependencies: VoiceCallServiceDependencies
) {
  const gather = async (
    input: PrepareVoiceCallInput
  ): Promise<Omit<VoiceCallDraftView, 'voiceCallId'>> => {
    authorise(dependencies.session, 'voice-call.prepare', input.organisationId);
    if (input.idempotencyKey.trim() === '') {
      throw new Error('VOICE_IDEMPOTENCY_KEY_REQUIRED');
    }
    const now = dependencies.clock.now();
    const [organisationRows, customerRows, settingsRows, channels, invoiceRows] =
      await Promise.all([
        dependencies.database
          .select()
          .from(organisations)
          .where(eq(organisations.id, input.organisationId))
          .limit(1),
        dependencies.database
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.organisationId, input.organisationId),
              eq(contacts.id, input.customerId)
            )
          )
          .limit(1),
        dependencies.database
          .select()
          .from(organisationVoiceSettings)
          .where(
            eq(
              organisationVoiceSettings.organisationId,
              input.organisationId
            )
          )
          .limit(1),
        dependencies.database
          .select()
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.organisationId, input.organisationId),
              eq(contactChannels.contactId, input.customerId),
              eq(contactChannels.kind, 'VOICE'),
              eq(contactChannels.usable, true)
            )
          )
          .orderBy(
            desc(contactChannels.approvedOverride),
            desc(contactChannels.approvedAt),
            desc(contactChannels.updatedAt)
          ),
        dependencies.database
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.organisationId, input.organisationId),
              eq(invoices.contactId, input.customerId)
            )
          )
      ]);
    const organisation = organisationRows[0];
    const customer = customerRows[0];
    const settings = settingsRows[0];
    if (organisation === undefined || customer === undefined) {
      throw new Error('VOICE_CUSTOMER_NOT_FOUND');
    }

    const invoiceIds = invoiceRows.map((invoice) => invoice.id);
    const activeChases =
      invoiceIds.length === 0
        ? []
        : await dependencies.database
            .select({
              invoiceId: invoiceChases.invoiceId,
              sequenceId: invoiceChases.sequenceId
            })
            .from(invoiceChases)
            .innerJoin(
              reminderSequences,
              and(
                eq(reminderSequences.id, invoiceChases.sequenceId),
                eq(reminderSequences.organisationId, input.organisationId),
                eq(reminderSequences.enabled, true)
              )
            )
            .where(
              and(
                eq(invoiceChases.organisationId, input.organisationId),
                eq(invoiceChases.customerId, input.customerId),
                eq(invoiceChases.status, 'ACTIVE'),
                inArray(invoiceChases.invoiceId, invoiceIds)
              )
            );
    const sequenceIds = [
      ...new Set(activeChases.map((chase) => chase.sequenceId))
    ];
    const pauseTargets = [eq(pauses.contactId, input.customerId)];
    if (invoiceIds.length > 0) {
      pauseTargets.push(inArray(pauses.invoiceId, invoiceIds));
    }
    if (sequenceIds.length > 0) {
      pauseTargets.push(inArray(pauses.sequenceId, sequenceIds));
    }
    const [activePauses, openDisputes, activePromises, whitelistRows, attempts] =
      await Promise.all([
        dependencies.database
          .select()
          .from(pauses)
          .where(
            and(
              eq(pauses.organisationId, input.organisationId),
              eq(pauses.active, true),
              or(isNull(pauses.expiresAt), gt(pauses.expiresAt, now)),
              or(...pauseTargets)
            )
          ),
        dependencies.database
          .select()
          .from(disputes)
          .where(
            and(
              eq(disputes.organisationId, input.organisationId),
              eq(disputes.contactId, input.customerId),
              eq(disputes.status, 'OPEN')
            )
          ),
        dependencies.database
          .select()
          .from(paymentPromises)
          .where(
            and(
              eq(paymentPromises.organisationId, input.organisationId),
              eq(paymentPromises.contactId, input.customerId),
              eq(paymentPromises.status, 'ACTIVE')
            )
          ),
        dependencies.database
          .select()
          .from(reminderWhitelistEntries)
          .where(
            and(
              eq(
                reminderWhitelistEntries.organisationId,
                input.organisationId
              ),
              eq(reminderWhitelistEntries.contactId, input.customerId),
              isNull(reminderWhitelistEntries.removedAt)
            )
          ),
        dependencies.repository.recentProviderAcceptedAttempts({
          organisationId: input.organisationId,
          contactId: input.customerId,
          from: new Date(0),
          before: new Date(now.getTime() + 1)
        })
      ]);

    const selectedChannel = channels.find(
      (channel) => normaliseVoiceNumber(channel.normalisedValue) !== null
    );
    const destinationNumber =
      selectedChannel === undefined
        ? null
        : normaliseVoiceNumber(selectedChannel.normalisedValue);
    const today = localDate(now, organisation.timeZone);
    const activePromiseExists = activePromises.some((promise) =>
      activePromise(promise, today)
    );
    const clientWhitelisted = whitelistRows.some(
      (entry) => entry.scope === 'CLIENT'
    );
    const chaseByInvoice = new Map(
      activeChases.map((chase) => [chase.invoiceId, chase])
    );
    const invoiceDraft = buildCombinedVoiceDraft({
      currentLocalDate: today,
      organisationCurrency: organisation.baseCurrency,
      invoices: invoiceRows.map((invoice) => {
        const chase = chaseByInvoice.get(invoice.id);
        return {
          id: invoice.id,
          xeroInvoiceId: invoice.xeroInvoiceId,
          invoiceNumber: invoice.invoiceNumber,
          type: invoice.type,
          status: invoice.status,
          amountDue: invoice.amountDue,
          currency: invoice.currency,
          dueDate: invoice.dueDate,
          contactActive: customer.active,
          invoiceActive: invoice.resolvedAt === null,
          invoicePaused: activePauses.some(
            (pause) => pause.scope === 'invoice' && pause.invoiceId === invoice.id
          ),
          customerPaused: activePauses.some(
            (pause) => pause.scope === 'customer'
          ),
          sequencePaused:
            chase !== undefined &&
            activePauses.some(
              (pause) =>
                pause.scope === 'sequence' &&
                pause.sequenceId === chase.sequenceId
            ),
          whitelisted:
            clientWhitelisted ||
            whitelistRows.some(
              (entry) =>
                entry.scope === 'INVOICE' && entry.invoiceId === invoice.id
            ),
          disputed: openDisputes.some(
            (dispute) =>
              dispute.invoiceId === null || dispute.invoiceId === invoice.id
          ),
          promiseToPayActive: activePromiseExists,
          activeChase: chase !== undefined
        };
      })
    });
    const voiceSuppressed =
      destinationNumber === null
        ? false
        : (
            await dependencies.database
              .select({ id: suppressions.id })
              .from(suppressions)
              .where(
                and(
                  eq(suppressions.organisationId, input.organisationId),
                  eq(suppressions.channel, 'VOICE'),
                  eq(suppressions.normalisedDestination, destinationNumber),
                  eq(suppressions.consentState, 'SUPPRESSED')
                )
              )
              .limit(1)
          ).length > 0;
    const inFlight =
      (
        await dependencies.database
          .select({ id: voiceCallRequests.id })
          .from(voiceCallRequests)
          .where(
            and(
              eq(voiceCallRequests.organisationId, input.organisationId),
              inArray(voiceCallRequests.state, [
                'SUBMITTING',
                'ACCEPTED',
                'IN_PROGRESS',
                'UNKNOWN'
              ])
            )
          )
          .limit(1)
      ).length > 0;
    const decision = evaluateVoiceContactPolicy({
      now,
      timezone: settings?.timezone ?? organisation.timeZone,
      holidays: [...dependencies.holidays.list(input.organisationId)],
      weekdayStartLocal: settings?.weekdayStartLocal.slice(0, 5) ?? '09:00',
      weekdayEndLocal: settings?.weekdayEndLocal.slice(0, 5) ?? '17:00',
      featureEnabled: settings?.enabled === true,
      permissionAllowed: true,
      destinationValid: destinationNumber !== null,
      voiceSuppressed,
      disputeOpen: openDisputes.some((dispute) => dispute.invoiceId === null),
      promiseToPayActive: activePromiseExists,
      paused: activePauses.some((pause) => pause.scope === 'customer'),
      whitelisted: clientWhitelisted,
      staleAccountData:
        organisation.maintenanceMode ||
        !['READY', 'RECONCILED'].includes(organisation.operationalState) ||
        organisation.lastSuccessfulSyncAt === null,
      organisationCallInFlight: inFlight,
      attempts,
      includedInvoiceIds: invoiceDraft.includedInvoices.map(
        (invoice) => invoice.id
      ),
      excludedInvoices: invoiceDraft.excludedInvoices
    });
    const includedInvoices: ApprovedVoiceInvoiceFact[] =
      invoiceDraft.includedInvoices.map((invoice) => ({
        invoiceId: invoice.id,
        xeroInvoiceId: invoice.xeroInvoiceId,
        invoiceNumber: invoice.invoiceNumber,
        amountDue: normaliseVoiceAmount(invoice.amountDue),
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        syncVersion:
          invoiceRows.find((row) => row.id === invoice.id)?.syncVersion ?? 0
      }));
    const approvedFacts =
      destinationNumber !== null &&
      settings !== undefined &&
      settings.agentId !== null &&
      settings.agentVersion !== null &&
      settings.voiceId !== null &&
      settings.voipcloudUserNumber !== null &&
      settings.ttsVoiceId !== null &&
      settings.gatewayFlowVersion !== null
        ? snapshotFacts({
            accountName: customer.name,
            destinationNumber,
            outboundNumber: settings.outboundNumber,
            combinedAmount: invoiceDraft.combinedAmount,
            currency: invoiceDraft.currency,
            agentId: settings.agentId,
            agentVersion: settings.agentVersion,
            voiceId: settings.voiceId,
            voipcloudUserNumber: settings.voipcloudUserNumber,
            ttsVoiceId: settings.ttsVoiceId,
            gatewayFlowVersion: settings.gatewayFlowVersion,
            voiceSettingsUpdatedAt: settings.updatedAt,
            transferTargetLabel: settings.officeDestinationLabel,
            invoices: includedInvoices
          })
        : null;
    const acceptedDates = attempts.map((attempt) => attempt.providerAcceptedAt);
    const rollingCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const thisMonth = localMonth(now, settings?.timezone ?? organisation.timeZone);
    return {
      idempotencyKey: input.idempotencyKey,
      allowed: decision.allowed,
      blockCode: decision.blockCode,
      customerId: customer.id,
      customerName: customer.name,
      destinationNumber,
      destinationSource: selectedChannel?.sourceValue ?? null,
      outboundNumber: settings?.outboundNumber ?? null,
      callerIdentityLabel: settings?.outboundNumber ?? null,
      transferTargetLabel: settings?.officeDestinationLabel ?? null,
      combinedAmount: invoiceDraft.combinedAmount,
      currency: invoiceDraft.currency,
      includedInvoices,
      excludedInvoices: invoiceDraft.excludedInvoices,
      attemptsLastSevenDays: acceptedDates.filter(
        (acceptedAt) => acceptedAt.getTime() > rollingCutoff
      ).length,
      attemptsThisMonth: acceptedDates.filter(
        (acceptedAt) =>
          localMonth(
            acceptedAt,
            settings?.timezone ?? organisation.timeZone
          ) === thisMonth
      ).length,
      nextPermittedAt: decision.nextPermittedAt,
      callFlowVersion: fixedVoiceCallCopy.version,
      callFlowHash: flowHash,
      approvedFacts,
      approvedFactsHash:
        approvedFacts === null ? null : buildApprovedVoiceFactsHash(approvedFacts)
    };
  };

  const prepare = async (
    input: PrepareVoiceCallInput
  ): Promise<VoiceCallDraftView> => {
    const view = await gather(input);
    if (!view.allowed || view.approvedFacts === null) {
      return { ...view, voiceCallId: null };
    }
    const existing = await dependencies.database
      .select({
        id: voiceCallRequests.id,
        contactId: voiceCallRequests.contactId
      })
      .from(voiceCallRequests)
      .where(
        and(
          eq(voiceCallRequests.organisationId, input.organisationId),
          eq(voiceCallRequests.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (existing[0] !== undefined) {
      if (existing[0].contactId !== input.customerId) {
        throw new Error('VOICE_CALL_APPROVAL_MISMATCH');
      }
      return { ...view, voiceCallId: existing[0].id };
    }
    const facts = view.approvedFacts;
    const created = await dependencies.repository.createDraft({
      organisationId: input.organisationId,
      contactId: input.customerId,
      actorUserId: dependencies.session.userId,
      accountName: facts.accountName,
      destinationNumber: facts.destinationNumber,
      outboundNumber: facts.outboundNumber,
      combinedAmount: facts.combinedAmount,
      currency: facts.currency,
      voipcloudUserNumber: facts.voipcloudUserNumber,
      ttsVoiceId: facts.ttsVoiceId,
      gatewayFlowVersion: facts.gatewayFlowVersion,
      agentId: facts.agentId,
      agentVersion: facts.agentVersion,
      voiceId: facts.voiceId,
      voiceSettingsUpdatedAt: new Date(facts.voiceSettingsUpdatedAt),
      transferTargetLabel: facts.transferTargetLabel,
      idempotencyKey: input.idempotencyKey,
      invoices: facts.invoices.map((invoice) => ({
        invoiceId: invoice.invoiceId,
        xeroInvoiceId: invoice.xeroInvoiceId,
        invoiceNumber: invoice.invoiceNumber,
        amountDue: invoice.amountDue,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        syncVersion: invoice.syncVersion,
        snapshotAt: dependencies.clock.now()
      })),
      now: dependencies.clock.now()
    });
    return { ...view, voiceCallId: created.id };
  };

  const approveAndQueue = async (
    input: ApproveAndQueueVoiceCallInput
  ): Promise<{ voiceCallId: string; created: boolean }> => {
    authorise(dependencies.session, 'voice-call.place', input.organisationId);
    if (!input.confirmed) throw new Error('VOICE_CALL_CONFIRMATION_REQUIRED');
    const draft = await dependencies.repository.loadForExecution(
      input.organisationId,
      input.voiceCallId
    );
    if (
      draft === null ||
      draft.contactId !== input.customerId ||
      draft.idempotencyKey !== input.idempotencyKey
    ) {
      throw new Error('VOICE_CALL_APPROVAL_MISMATCH');
    }
    if (draft.state !== 'DRAFT') {
      const repeated = await dependencies.repository.approveAndQueue({
        organisationId: input.organisationId,
        voiceCallId: input.voiceCallId,
        actorUserId: dependencies.session.userId,
        idempotencyKey: input.idempotencyKey,
        callFlowVersion: input.callFlowVersion,
        callFlowHash: input.callFlowHash,
        approvedFactsHash: input.approvedFactsHash,
        now: dependencies.clock.now()
      });
      await dependencies.publisher.publish(
        jobNames.voiceCallExecute,
        {
          organisationId: input.organisationId,
          voiceCallId: input.voiceCallId,
          provider: 'VOIPCLOUD'
        },
        { singletonKey: `voice-call:${input.voiceCallId}` }
      );
      return repeated;
    }

    const current = await gather(input);
    if (!current.allowed) {
      throw new Error(current.blockCode ?? 'VOICE_CALL_NOT_ALLOWED');
    }
    if (
      current.approvedFacts === null ||
      current.approvedFactsHash === null ||
      input.callFlowVersion !== current.callFlowVersion ||
      input.callFlowHash !== current.callFlowHash ||
      input.approvedFactsHash !== current.approvedFactsHash
    ) {
      throw new Error('STALE_ACCOUNT_DATA');
    }
    if (
      draft.accountName === null ||
      draft.agentId === null ||
      draft.agentVersion === null ||
      draft.voiceId === null ||
      draft.voipcloudUserNumber === null ||
      draft.ttsVoiceId === null ||
      draft.gatewayFlowVersion === null
    ) {
      throw new Error('STALE_ACCOUNT_DATA');
    }
    const draftFacts = snapshotFacts({
      accountName: draft.accountName,
      destinationNumber: draft.destinationNumber,
      outboundNumber: draft.outboundNumber,
      combinedAmount: draft.combinedAmount,
      currency: draft.currency,
      agentId: draft.agentId,
      agentVersion: draft.agentVersion,
      voiceId: draft.voiceId,
      voipcloudUserNumber: draft.voipcloudUserNumber,
      ttsVoiceId: draft.ttsVoiceId,
      gatewayFlowVersion: draft.gatewayFlowVersion,
      voiceSettingsUpdatedAt: draft.voiceSettingsUpdatedAt,
      transferTargetLabel: draft.transferTargetLabel,
      invoices: draft.invoices.map((invoice) => ({
        invoiceId: invoice.invoiceId,
        xeroInvoiceId: invoice.xeroInvoiceId,
        invoiceNumber: invoice.invoiceNumber,
        amountDue: invoice.amountDue,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        syncVersion: invoice.syncVersion
      }))
    });
    if (buildApprovedVoiceFactsHash(draftFacts) !== input.approvedFactsHash) {
      throw new Error('STALE_ACCOUNT_DATA');
    }
    const approved = await dependencies.repository.approveAndQueue({
      organisationId: input.organisationId,
      voiceCallId: input.voiceCallId,
      actorUserId: dependencies.session.userId,
      idempotencyKey: input.idempotencyKey,
      callFlowVersion: input.callFlowVersion,
      callFlowHash: input.callFlowHash,
      approvedFactsHash: input.approvedFactsHash,
      now: dependencies.clock.now()
    });
    if (approved.created) {
      await dependencies.database.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: dependencies.session.userId,
        eventType: 'VOICE_CALL_FACTS_APPROVED',
        entityType: 'VOICE_CALL',
        entityId: input.voiceCallId,
        correlationId: input.idempotencyKey,
        afterValue: {
          state: 'QUEUED',
          invoiceCount: draft.invoices.length,
          callFlowVersion: input.callFlowVersion
        },
        occurredAt: dependencies.clock.now()
      });
    }
    await dependencies.publisher.publish(
      jobNames.voiceCallExecute,
      {
        organisationId: input.organisationId,
        voiceCallId: input.voiceCallId,
        provider: 'VOIPCLOUD'
      },
      { singletonKey: `voice-call:${input.voiceCallId}` }
    );
    return approved;
  };

  return { prepare, approveAndQueue };
}
