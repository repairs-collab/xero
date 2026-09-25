import { randomUUID } from 'node:crypto';

import {
  and,
  eq,
  inArray
} from 'drizzle-orm';

import {
  approvals,
  contactChannels,
  contacts,
  type Database,
  invoiceChases,
  invoices,
  organisations,
  PostgresApprovalRepository,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages,
  stageInstances,
  tasks
} from '@bc5000/db';
import {
  calculateStageOccurrences,
  createBusinessCalendar,
  evaluateEligibility,
  renderSms,
  type ReminderStageChannel
} from '@bc5000/domain';
import type { XeroResult } from '@bc5000/integrations/xero';

export interface ReminderCalculationClock {
  now(): Date;
}

export interface ReminderCalculationDependencies {
  database: Database;
  clock: ReminderCalculationClock;
  xero: {
    getOnlineInvoiceUrl(invoiceId: string): Promise<XeroResult<string>>;
  };
}

export interface CalculationSummary {
  createdStages: number;
  createdApprovals: number;
  createdTasks: number;
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

const previewFor = (input: {
  channel: 'SMS' | 'XERO_EMAIL';
  template: string | null;
  customerName: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  dueDate: string;
  onlineInvoiceUrl: string | null;
  organisationName: string;
  maxSmsSegments: number;
}): string => {
  if (input.channel === 'XERO_EMAIL') {
    return `Xero invoice email for ${input.invoiceNumber} to ${input.customerName}`;
  }
  if (input.template === null) {
    throw new Error('An SMS stage must have a template');
  }
  return renderSms(
    input.template,
    {
      customer_name: input.customerName,
      invoice_number: input.invoiceNumber,
      amount_due: input.amountDue,
      currency: input.currency,
      due_date: input.dueDate,
      online_invoice_url: input.onlineInvoiceUrl ?? '' ,
      organisation_name: input.organisationName
    },
    { maxSegments: input.maxSmsSegments }
  ).content;
};

export async function calculateReminderWork(
  dependencies: ReminderCalculationDependencies,
  organisationId: string
): Promise<CalculationSummary> {
  const now = dependencies.clock.now();
  const summary: CalculationSummary = {
    createdStages: 0,
    createdApprovals: 0,
    createdTasks: 0,
    skippedOccurrences: 0
  };
  await new PostgresApprovalRepository(
    dependencies.database
  ).expirePastDue(organisationId, now);

  const [organisation] = await dependencies.database
    .select()
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (organisation === undefined) throw new Error('Organisation was not found');

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
      maxSmsSegments: reminderSequenceVersions.maxSmsSegments
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
        eq(reminderSequences.enabled, true)
      )
    );

  const invoiceRows = await dependencies.database
    .select({ invoice: invoices, contact: contacts })
    .from(invoices)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, invoices.contactId),
        eq(contacts.organisationId, organisationId)
      )
    )
    .where(eq(invoices.organisationId, organisationId));

  for (const sequence of sequenceRows) {
    const configuredStages = await dependencies.database
      .select()
      .from(sequenceStages)
      .where(
        and(
          eq(sequenceStages.organisationId, organisationId),
          eq(sequenceStages.sequenceVersionId, sequence.versionId),
          eq(sequenceStages.enabled, true)
        )
      );
    const stageGroups = new Map<
      string,
      { id: string; offsetDays: number; channels: ReminderStageChannel[] }
    >();
    for (const stage of configuredStages) {
      const current = stageGroups.get(stage.stageKey) ?? {
        id: stage.stageKey,
        offsetDays: stage.offsetDays,
        channels: []
      };
      current.channels.push(stage.channel);
      stageGroups.set(stage.stageKey, current);
    }

    for (const row of invoiceRows) {
      if (Number(row.invoice.amountDue) < Number(sequence.minimumBalance)) {
        continue;
      }
      const smsChannels = await dependencies.database
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.organisationId, organisationId),
            eq(contactChannels.contactId, row.contact.id),
            eq(contactChannels.kind, 'SMS'),
            eq(contactChannels.usable, true)
          )
        );
      const [existingChase] = await dependencies.database
        .select()
        .from(invoiceChases)
        .where(
          and(
            eq(invoiceChases.organisationId, organisationId),
            eq(invoiceChases.invoiceId, row.invoice.id),
            eq(invoiceChases.sequenceId, sequence.sequenceId)
          )
        )
        .limit(1);
      const chaseId = existingChase?.id ?? randomUUID();
      if (existingChase === undefined) {
        await dependencies.database.insert(invoiceChases).values({
          id: chaseId,
          organisationId,
          invoiceId: row.invoice.id,
          sequenceId: sequence.sequenceId,
          customerId: row.contact.id,
          status: 'ACTIVE',
          updatedAt: now
        });
      }

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
          stages: [...stageGroups.values()]
        },
        [
          {
            invoiceId: row.invoice.id,
            customerId: row.contact.id,
            dueDate: row.invoice.dueDate,
            amountDue: row.invoice.amountDue,
            currency: row.invoice.currency
          }
        ],
        createBusinessCalendar({
          zone: organisation.timeZone,
          holidays: []
        })
      );
      let onlineInvoiceUrl = row.invoice.onlineInvoiceUrl;

      for (const occurrence of occurrences) {
        const configured = configuredStages.find(
          (stage) =>
            (stage.stageKey === occurrence.stageId &&
              stage.channel === occurrence.channel) ||
            (occurrence.stageId === 'daily-after-30' &&
              stage.channel === 'SMS_DAILY')
        );
        if (configured === undefined) continue;
        const channelUsable =
          occurrence.channel === 'TASK' ||
          (occurrence.channel === 'SMS'
            ? smsChannels.length > 0
            : row.contact.email !== null);
        const eligibility = evaluateEligibility({
          type: row.invoice.type,
          status: row.invoice.status,
          amountDue: row.invoice.amountDue,
          contactActive: row.contact.active,
          invoicePaused: false,
          customerPaused: false,
          sequencePaused: false,
          channelUsable,
          channelSuppressed: false,
          stageCompleted: false
        });
        if (!eligibility.eligible) {
          summary.skippedOccurrences += 1;
          continue;
        }

        if (
          sequence.mode === 'REVIEW' &&
          occurrence.channel === 'SMS' &&
          configured.template?.includes('{{online_invoice_url}}') === true &&
          onlineInvoiceUrl === null
        ) {
          const online = await dependencies.xero.getOnlineInvoiceUrl(
            row.invoice.xeroInvoiceId
          );
          onlineInvoiceUrl = online.data;
          await dependencies.database
            .update(invoices)
            .set({ onlineInvoiceUrl })
            .where(eq(invoices.id, row.invoice.id));
        }

        const stageId = randomUUID();
        const isTask = occurrence.channel === 'TASK';
        const status = isTask
          ? 'DELIVERED'
          : sequence.mode === 'REVIEW'
            ? 'AWAITING_APPROVAL'
            : 'SCHEDULED';
        const inserted = await dependencies.database
          .insert(stageInstances)
          .values({
            id: stageId,
            organisationId,
            invoiceChaseId: chaseId,
            sequenceVersionId: sequence.versionId,
            stageKey: occurrence.stageId,
            channel: occurrence.channel,
            status,
            scheduledAt: new Date(occurrence.scheduledAtUtc),
            sourceVersion: row.invoice.syncVersion,
            completedAt: isTask ? now : null,
            updatedAt: now
          })
          .onConflictDoNothing({
            target: [
              stageInstances.organisationId,
              stageInstances.invoiceChaseId,
              stageInstances.stageKey,
              stageInstances.channel,
              stageInstances.scheduledAt
            ]
          })
          .returning({ id: stageInstances.id });
        if (inserted.length === 0) continue;
        summary.createdStages += 1;

        if (occurrence.channel !== 'TASK' && sequence.mode === 'REVIEW') {
          const preview = previewFor({
            channel: occurrence.channel,
            template: configured.template,
            customerName: row.contact.name,
            invoiceNumber: row.invoice.invoiceNumber,
            amountDue: row.invoice.amountDue,
            currency: row.invoice.currency,
            dueDate: row.invoice.dueDate,
            onlineInvoiceUrl,
            organisationName: organisation.name,
            maxSmsSegments: sequence.maxSmsSegments
          });
          await dependencies.database.insert(approvals).values({
            organisationId,
            stageInstanceId: stageId,
            renderedPreview: preview,
            sourceVersion: row.invoice.syncVersion,
            status: 'PENDING',
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
          });
          summary.createdApprovals += 1;
        }

        const isEscalation =
          occurrence.channel === 'TASK' || configured.offsetDays === 30;
        if (isEscalation) {
          const existingTasks = await dependencies.database
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.organisationId, organisationId),
                eq(tasks.contactId, row.contact.id),
                eq(tasks.sequenceId, sequence.sequenceId),
                eq(tasks.kind, 'DEBT_ESCALATION'),
                inArray(tasks.status, ['OPEN', 'COMPLETED'])
              )
            )
            .limit(1);
          if (existingTasks.length === 0) {
            const createdTask = await dependencies.database.insert(tasks).values({
              organisationId,
              contactId: row.contact.id,
              invoiceId: row.invoice.id,
              sequenceId: sequence.sequenceId,
              kind: 'DEBT_ESCALATION',
              status: 'OPEN',
              dueAt: new Date(occurrence.scheduledAtUtc),
              summary: `Escalate overdue invoice ${row.invoice.invoiceNumber}`,
              updatedAt: now
            }).onConflictDoNothing().returning({ id: tasks.id });
            summary.createdTasks += createdTask.length;
          }
        }
      }
    }
  }

  return summary;
}
