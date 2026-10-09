import { and, eq } from 'drizzle-orm';

import {
  auditEvents,
  createVoicePreparationService,
  type Database,
  invoiceChases,
  invoices,
  PostgresOrganisationSafetyRepository,
  PostgresTaskRepository,
  PostgresVoiceCallRepository,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages
} from '@bc5000/db';
import {
  calculateStageOccurrences,
  createBusinessCalendar,
  groupVoiceSequenceCandidates,
  voiceSequenceIdempotencyKey,
  type VoiceSequenceInvoiceCandidate
} from '@bc5000/domain';

export interface VoiceReminderCalculationDependencies {
  database: Database;
  clock: { now(): Date };
  holidays: { list(organisationId: string): readonly string[] };
}

export interface VoiceCalculationSummary {
  preparedCalls: number;
  reviewCalls: number;
  approvedCalls: number;
  contactReviewTasks: number;
  skippedOccurrences: number;
}

const localDate = (instant: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const allowedCurrenciesFrom = (configuration: Record<string, unknown>) => {
  const configured = configuration.allowedCurrencies;
  return new Set(
    Array.isArray(configured)
      ? configured.filter(
          (value): value is string =>
            typeof value === 'string' && value.trim() !== ''
        )
      : []
  );
};

export async function calculateVoiceReminderWork(
  dependencies: VoiceReminderCalculationDependencies,
  organisationId: string
): Promise<VoiceCalculationSummary> {
  const now = dependencies.clock.now();
  const summary: VoiceCalculationSummary = {
    preparedCalls: 0,
    reviewCalls: 0,
    approvedCalls: 0,
    contactReviewTasks: 0,
    skippedOccurrences: 0
  };
  const safety = new PostgresOrganisationSafetyRepository(
    dependencies.database
  );
  const organisation = await dependencies.database.transaction(
    (transaction) =>
      safety.assertOperationalMutationAllowed(transaction, organisationId)
  );
  const voiceRepository = new PostgresVoiceCallRepository(
    dependencies.database
  );
  const preparation = createVoicePreparationService({
    database: dependencies.database,
    repository: voiceRepository,
    clock: dependencies.clock,
    holidays: dependencies.holidays
  });
  const taskRepository = new PostgresTaskRepository(dependencies.database);
  const sequenceRows = await dependencies.database
    .select({
      sequenceId: reminderSequences.id,
      mode: reminderSequences.mode,
      versionId: reminderSequenceVersions.id,
      dailyBasis: reminderSequenceVersions.dailyBasis,
      sendTime: reminderSequenceVersions.sendTime,
      socialWindowStart: reminderSequenceVersions.socialWindowStart,
      socialWindowEnd: reminderSequenceVersions.socialWindowEnd,
      minimumBalance: reminderSequenceVersions.minimumBalance,
      configuration: reminderSequenceVersions.configuration
    })
    .from(reminderSequences)
    .innerJoin(
      reminderSequenceVersions,
      and(
        eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
        eq(reminderSequenceVersions.organisationId, organisationId),
        eq(reminderSequenceVersions.status, 'ACTIVE')
      )
    )
    .where(
      and(
        eq(reminderSequences.organisationId, organisationId),
        eq(reminderSequences.kind, 'VOICE'),
        eq(reminderSequences.enabled, true)
      )
    );
  const invoiceRows = await dependencies.database
    .select()
    .from(invoices)
    .where(eq(invoices.organisationId, organisationId));

  for (const sequence of sequenceRows) {
    const allowedCurrencies = allowedCurrenciesFrom(sequence.configuration);
    const candidateInvoices = invoiceRows.filter(
      (invoice) =>
        invoice.contactId !== null &&
        invoice.type === 'ACCREC' &&
        invoice.status === 'AUTHORISED' &&
        invoice.resolvedAt === null &&
        Number(invoice.amountDue) > 0 &&
        Number(invoice.amountDue) >= Number(sequence.minimumBalance) &&
        allowedCurrencies.has(invoice.currency)
    );
    if (candidateInvoices.length > 0) {
      await dependencies.database.transaction(async (transaction) => {
        await safety.assertOperationalMutationAllowed(
          transaction,
          organisationId
        );
        await transaction
          .insert(invoiceChases)
          .values(
            candidateInvoices.map((invoice) => ({
              organisationId,
              invoiceId: invoice.id,
              sequenceId: sequence.sequenceId,
              customerId: invoice.contactId,
              status: 'ACTIVE' as const,
              updatedAt: now
            }))
          )
          .onConflictDoNothing({
            target: [
              invoiceChases.organisationId,
              invoiceChases.invoiceId,
              invoiceChases.sequenceId
            ]
          });
      });
    }

    const [configuredStages, activeChases] = await Promise.all([
      dependencies.database
        .select()
        .from(sequenceStages)
        .where(
          and(
            eq(sequenceStages.organisationId, organisationId),
            eq(sequenceStages.sequenceVersionId, sequence.versionId),
            eq(sequenceStages.channel, 'VOICE'),
            eq(sequenceStages.enabled, true)
          )
        ),
      dependencies.database
        .select({ invoice: invoices })
        .from(invoiceChases)
        .innerJoin(
          invoices,
          and(
            eq(invoices.id, invoiceChases.invoiceId),
            eq(invoices.organisationId, organisationId)
          )
        )
        .where(
          and(
            eq(invoiceChases.organisationId, organisationId),
            eq(invoiceChases.sequenceId, sequence.sequenceId),
            eq(invoiceChases.status, 'ACTIVE')
          )
        )
    ]);
    if (configuredStages.length === 0 || activeChases.length === 0) continue;

    const occurrences = calculateStageOccurrences(
      {
        organisationId,
        sequenceVersionId: sequence.versionId,
        zone: organisation.timeZone,
        sendTime: sequence.sendTime.slice(0, 5),
        socialWindow: {
          start: sequence.socialWindowStart.slice(0, 5),
          end: sequence.socialWindowEnd.slice(0, 5)
        },
        dailyBasis: sequence.dailyBasis,
        asOfLocalDate: localDate(now, organisation.timeZone),
        stages: configuredStages.map((stage) => ({
          id: stage.stageKey,
          offsetDays: stage.offsetDays,
          channels: ['VOICE']
        }))
      },
      activeChases.map(({ invoice }) => ({
        invoiceId: invoice.id,
        customerId: invoice.contactId,
        dueDate: invoice.dueDate,
        amountDue: invoice.amountDue,
        currency: invoice.currency
      })),
      createBusinessCalendar({
        zone: organisation.timeZone,
        holidays: [...dependencies.holidays.list(organisationId)]
      })
    ).filter((occurrence) => occurrence.channel === 'VOICE');
    const invoiceById = new Map(
      activeChases.map(({ invoice }) => [invoice.id, invoice])
    );
    const occurrenceGroups = new Map<
      string,
      {
        stageKey: string;
        localOccurrenceDate: string;
        scheduledAt: Date;
        invoices: VoiceSequenceInvoiceCandidate[];
      }
    >();
    for (const occurrence of occurrences) {
      const invoice = invoiceById.get(occurrence.invoiceId);
      if (invoice === undefined || invoice.contactId === null) continue;
      const key = `${occurrence.stageId}\u0000${occurrence.localDate}`;
      const current = occurrenceGroups.get(key) ?? {
        stageKey: occurrence.stageId,
        localOccurrenceDate: occurrence.localDate,
        scheduledAt: new Date(occurrence.scheduledAtUtc),
        invoices: []
      };
      current.invoices.push({
        invoiceId: invoice.id,
        customerId: invoice.contactId,
        amountDue: invoice.amountDue,
        currency: invoice.currency
      });
      occurrenceGroups.set(key, current);
    }

    for (const occurrence of occurrenceGroups.values()) {
      const candidates = groupVoiceSequenceCandidates({
        organisationId,
        sequenceVersionId: sequence.versionId,
        stageKey: occurrence.stageKey,
        localOccurrenceDate: occurrence.localOccurrenceDate,
        invoices: occurrence.invoices
      });
      for (const candidate of candidates) {
        const sourceKind =
          sequence.mode === 'AUTOMATIC'
            ? 'SEQUENCE_AUTOMATIC'
            : 'SEQUENCE_REVIEW';
        const result = await preparation.create({
          organisationId,
          customerId: candidate.customerId,
          actorUserId: null,
          idempotencyKey: voiceSequenceIdempotencyKey(candidate),
          initialState:
            sequence.mode === 'AUTOMATIC' ? 'APPROVED' : 'DRAFT',
          source: {
            kind: sourceKind,
            sequenceId: sequence.sequenceId,
            sequenceVersionId: sequence.versionId,
            stageKey: candidate.stageKey,
            scheduledAt: occurrence.scheduledAt,
            localOccurrenceDate: candidate.localOccurrenceDate
          },
          invoiceIds: candidate.invoices.map((invoice) => invoice.invoiceId)
        });
        if (result.voiceCallId !== null) {
          summary.preparedCalls += 1;
          if (sequence.mode === 'AUTOMATIC') summary.approvedCalls += 1;
          else summary.reviewCalls += 1;
          continue;
        }
        if (result.blockCode === 'INVALID_DESTINATION') {
          const task = await taskRepository.ensureVoiceContactReview({
            organisationId,
            contactId: candidate.customerId,
            sequenceId: sequence.sequenceId,
            invoiceId: candidate.invoices[0]?.invoiceId ?? null,
            summary: 'Add or correct a callable customer phone number',
            now
          });
          if (task.created) summary.contactReviewTasks += 1;
        } else {
          summary.skippedOccurrences += 1;
        }
      }
    }
  }

  if (summary.preparedCalls > 0 || summary.contactReviewTasks > 0) {
    await dependencies.database.insert(auditEvents).values({
      organisationId,
      actorUserId: null,
      eventType: 'VOICE_REMINDER_CALCULATION_COMPLETED',
      entityType: 'ORGANISATION',
      entityId: organisationId,
      afterValue: {
        sequenceCount: sequenceRows.length,
        preparedCalls: summary.preparedCalls,
        reviewCalls: summary.reviewCalls,
        approvedCalls: summary.approvedCalls,
        contactReviewTasks: summary.contactReviewTasks,
        skippedOccurrences: summary.skippedOccurrences
      },
      occurredAt: now
    });
  }
  return summary;
}
