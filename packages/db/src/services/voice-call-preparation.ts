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

import {
  buildCombinedVoiceDraft,
  evaluateVoiceContactPolicy,
  fixedVoiceCallCopy,
  normaliseVoiceAmount,
  type VoiceDraftExcludedInvoice,
  type VoicePolicyBlockCode
} from '@bc5000/domain';

import type { Database } from '../client.js';
import type {
  PostgresVoiceCallRepository,
  VoiceCallAggregate,
  VoiceCallSourceInput
} from '../repositories/voice-call-repository.js';
import {
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
  voiceCallRequests
} from '../schema/index.js';

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

export type VoicePreparationSource =
  | { kind: 'MANUAL' }
  | {
      kind: 'SEQUENCE_REVIEW' | 'SEQUENCE_AUTOMATIC';
      sequenceId: string;
      sequenceVersionId: string;
      stageKey: string;
      scheduledAt: Date;
      localOccurrenceDate: string;
    };

export interface VoicePreparationInput {
  organisationId: string;
  customerId: string;
  actorUserId: string | null;
  idempotencyKey: string;
  initialState: 'DRAFT' | 'APPROVED';
  source: VoicePreparationSource;
  invoiceIds?: readonly string[];
  permissionAllowed?: boolean;
}

export interface VoicePreparationServiceDependencies {
  database: Database;
  repository: PostgresVoiceCallRepository;
  clock: { now(): Date };
  holidays: { list(organisationId: string): readonly string[] };
}

export interface VoicePreparationService {
  evaluate(input: VoicePreparationInput): Promise<VoiceCallDraftView>;
  create(input: VoicePreparationInput): Promise<VoiceCallDraftView>;
}

export const voiceCallFlowHash = `sha256:${createHash('sha256')
  .update(JSON.stringify(fixedVoiceCallCopy))
  .digest('hex')}`;

const validVoiceTypes = new Set([
  'FIXED_LINE',
  'MOBILE',
  'FIXED_LINE_OR_MOBILE',
  'VOIP'
]);

export const normaliseVoiceNumber = (value: string): string | null => {
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
    callFlowHash: voiceCallFlowHash,
    invoices: input.invoices.map((invoice) => ({
      ...invoice,
      amountDue: normaliseVoiceAmount(invoice.amountDue)
    }))
  });

export function approvedVoiceFactsFromStoredCall(
  call: VoiceCallAggregate
): ApprovedVoiceFacts | null {
  if (
    call.accountName === null ||
    call.agentId === null ||
    call.agentVersion === null ||
    call.voiceId === null ||
    call.voipcloudUserNumber === null ||
    call.ttsVoiceId === null ||
    call.gatewayFlowVersion === null
  ) {
    return null;
  }
  return snapshotFacts({
    accountName: call.accountName,
    destinationNumber: call.destinationNumber,
    outboundNumber: call.outboundNumber,
    combinedAmount: call.combinedAmount,
    currency: call.currency,
    agentId: call.agentId,
    agentVersion: call.agentVersion,
    voiceId: call.voiceId,
    voipcloudUserNumber: call.voipcloudUserNumber,
    ttsVoiceId: call.ttsVoiceId,
    gatewayFlowVersion: call.gatewayFlowVersion,
    voiceSettingsUpdatedAt: call.voiceSettingsUpdatedAt,
    transferTargetLabel: call.transferTargetLabel,
    invoices: call.invoices.map((invoice) => ({
      invoiceId: invoice.invoiceId,
      xeroInvoiceId: invoice.xeroInvoiceId,
      invoiceNumber: invoice.invoiceNumber,
      amountDue: invoice.amountDue,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      syncVersion: invoice.syncVersion
    }))
  });
}

const activePromise = (
  promise: { promisedDate: string; graceDays: number },
  today: string
): boolean => {
  const protectedUntil = new Date(`${promise.promisedDate}T00:00:00.000Z`);
  protectedUntil.setUTCDate(protectedUntil.getUTCDate() + promise.graceDays);
  return protectedUntil.toISOString().slice(0, 10) >= today;
};

const repositorySource = (
  source: VoicePreparationSource
): VoiceCallSourceInput =>
  source.kind === 'MANUAL'
    ? { source: 'MANUAL' }
    : {
        source: source.kind,
        sequenceId: source.sequenceId,
        sequenceVersionId: source.sequenceVersionId,
        stageKey: source.stageKey,
        scheduledAt: source.scheduledAt,
        localOccurrenceDate: source.localOccurrenceDate
      };

export function createVoicePreparationService(
  dependencies: VoicePreparationServiceDependencies
): VoicePreparationService {
  const evaluate = async (
    input: VoicePreparationInput
  ): Promise<VoiceCallDraftView> => {
    if (input.idempotencyKey.trim() === '') {
      throw new Error('VOICE_IDEMPOTENCY_KEY_REQUIRED');
    }
    const now = dependencies.clock.now();
    const [organisationRows, customerRows, settingsRows, channels, allInvoices] =
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

    const requestedInvoiceIds =
      input.invoiceIds === undefined ? null : new Set(input.invoiceIds);
    const invoiceRows =
      requestedInvoiceIds === null
        ? allInvoices
        : allInvoices.filter((invoice) => requestedInvoiceIds.has(invoice.id));
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
                inArray(invoiceChases.invoiceId, invoiceIds),
                input.source.kind === 'MANUAL'
                  ? undefined
                  : eq(invoiceChases.sequenceId, input.source.sequenceId)
              )
            );
    const sequenceIds = [
      ...new Set(activeChases.map((chase) => chase.sequenceId))
    ];
    const pauseTargets = [eq(pauses.contactId, input.customerId)];
    if (invoiceIds.length > 0) pauseTargets.push(inArray(pauses.invoiceId, invoiceIds));
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
              eq(reminderWhitelistEntries.organisationId, input.organisationId),
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
      permissionAllowed: input.permissionAllowed ?? true,
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
    const thisMonth = localMonth(
      now,
      settings?.timezone ?? organisation.timeZone
    );
    return {
      voiceCallId: null,
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
      callFlowHash: voiceCallFlowHash,
      approvedFacts,
      approvedFactsHash:
        approvedFacts === null ? null : buildApprovedVoiceFactsHash(approvedFacts)
    };
  };

  const create = async (
    input: VoicePreparationInput
  ): Promise<VoiceCallDraftView> => {
    const view = await evaluate(input);
    if (
      !view.allowed ||
      view.approvedFacts === null ||
      view.approvedFactsHash === null
    ) {
      return view;
    }
    const existing = await dependencies.database
      .select({
        id: voiceCallRequests.id,
        contactId: voiceCallRequests.contactId,
        source: voiceCallRequests.source
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
      if (
        existing[0].contactId !== input.customerId ||
        existing[0].source !== input.source.kind
      ) {
        throw new Error('VOICE_CALL_APPROVAL_MISMATCH');
      }
      return { ...view, voiceCallId: existing[0].id };
    }

    const facts = view.approvedFacts;
    const created = await dependencies.repository.createPrepared({
      organisationId: input.organisationId,
      contactId: input.customerId,
      actorUserId: input.actorUserId,
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
      initialState: input.initialState,
      source: repositorySource(input.source),
      callFlowVersion:
        input.initialState === 'APPROVED' ? view.callFlowVersion : null,
      callFlowHash: input.initialState === 'APPROVED' ? view.callFlowHash : null,
      approvedFactsHash:
        input.initialState === 'APPROVED' ? view.approvedFactsHash : null,
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

  return { evaluate, create };
}
