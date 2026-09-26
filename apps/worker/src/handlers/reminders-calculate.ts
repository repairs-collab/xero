import { randomUUID } from 'node:crypto';

import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  or
} from 'drizzle-orm';

import {
  approvals,
  contactChannels,
  contacts,
  type Database,
  disputes,
  invoiceChases,
  invoices,
  organisations,
  pauses,
  paymentPromises,
  PostgresApprovalRepository,
  reminderSequences,
  reminderSequenceVersions,
  sequenceStages,
  stageInstances,
  suppressions,
  tasks
} from '@bc5000/db';
import {
  calculateStageOccurrences,
  createBusinessCalendar,
  evaluateEligibility,
  renderSms,
  selectPreferredSmsChannel,
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

const promiseStillActive = (
  promisedDate: string,
  graceDays: number,
  now: Date
): boolean => {
  const end = new Date(`${promisedDate}T23:59:59.999Z`);
  end.setUTCDate(end.getUTCDate() + graceDays);
  return end >= now;
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

  const activeSequenceIds = new Set(
    sequenceRows.map((sequence) => sequence.sequenceId)
  );
  await dependencies.database.transaction(async (transaction) => {
    const pending = await transaction
      .select({
        approvalId: approvals.id,
        stageId: stageInstances.id,
        stageKey: stageInstances.stageKey,
        sequenceId: invoiceChases.sequenceId
      })
      .from(approvals)
      .innerJoin(
        stageInstances,
        and(
          eq(stageInstances.id, approvals.stageInstanceId),
          eq(stageInstances.organisationId, organisationId)
        )
      )
      .innerJoin(
        invoiceChases,
        and(
          eq(invoiceChases.id, stageInstances.invoiceChaseId),
          eq(invoiceChases.organisationId, organisationId)
        )
      )
      .where(
        and(
          eq(approvals.organisationId, organisationId),
          eq(approvals.status, 'PENDING')
        )
      )
      .for('update');
    const inactive = pending.filter(
      (row) =>
        row.stageKey !== 'manual' && !activeSequenceIds.has(row.sequenceId)
    );
    if (inactive.length === 0) return;
    const expired = await transaction
      .update(approvals)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          eq(approvals.organisationId, organisationId),
          eq(approvals.status, 'PENDING'),
          inArray(
            approvals.id,
            inactive.map((row) => row.approvalId)
          )
        )
      )
      .returning({ stageId: approvals.stageInstanceId });
    if (expired.length > 0) {
      await transaction
        .update(stageInstances)
        .set({ status: 'CANCELLED', updatedAt: now })
        .where(
          inArray(
            stageInstances.id,
            expired.map((row) => row.stageId)
          )
        );
    }
  });

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
      const smsChannel = selectPreferredSmsChannel(smsChannels);
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
        if (Number(row.invoice.amountDue) < Number(sequence.minimumBalance)) {
          continue;
        }
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

      const [activePauses, openDisputes, activePromises, channelSuppressions] =
        await Promise.all([
          dependencies.database
            .select()
            .from(pauses)
            .where(
              and(
                eq(pauses.organisationId, organisationId),
                eq(pauses.active, true),
                or(isNull(pauses.expiresAt), gt(pauses.expiresAt, now)),
                or(
                  and(
                    eq(pauses.scope, 'customer'),
                    eq(pauses.contactId, row.contact.id)
                  ),
                  and(
                    eq(pauses.scope, 'invoice'),
                    eq(pauses.invoiceId, row.invoice.id)
                  ),
                  and(
                    eq(pauses.scope, 'sequence'),
                    eq(pauses.sequenceId, sequence.sequenceId)
                  )
                )
              )
            ),
          dependencies.database
            .select({ id: disputes.id })
            .from(disputes)
            .where(
              and(
                eq(disputes.organisationId, organisationId),
                eq(disputes.contactId, row.contact.id),
                eq(disputes.status, 'OPEN'),
                or(
                  isNull(disputes.invoiceId),
                  eq(disputes.invoiceId, row.invoice.id)
                )
              )
            ),
          dependencies.database
            .select()
            .from(paymentPromises)
            .where(
              and(
                eq(paymentPromises.organisationId, organisationId),
                eq(paymentPromises.contactId, row.contact.id),
                eq(paymentPromises.status, 'ACTIVE')
              )
            ),
          dependencies.database
            .select()
            .from(suppressions)
            .where(
              and(
                eq(suppressions.organisationId, organisationId),
                eq(suppressions.consentState, 'SUPPRESSED'),
                or(
                  eq(
                    suppressions.normalisedDestination,
                    smsChannel?.normalisedValue ?? ''
                  ),
                  eq(
                    suppressions.normalisedDestination,
                    row.contact.email ?? ''
                  )
                )
              )
            )
        ]);
      const customerPaused = activePauses.some(
        (pause) => pause.scope === 'customer'
      );
      const invoicePaused = activePauses.some(
        (pause) => pause.scope === 'invoice'
      );
      const sequencePaused = activePauses.some(
        (pause) => pause.scope === 'sequence'
      );
      const promiseActive = activePromises.some((promise) =>
        promiseStillActive(promise.promisedDate, promise.graceDays, now)
      );

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
      const eligibleOccurrences = occurrences.flatMap((occurrence) => {
        const configured = configuredStages.find(
          (stage) =>
            (stage.stageKey === occurrence.stageId &&
              stage.channel === occurrence.channel) ||
            (occurrence.stageId === 'daily-after-30' &&
              stage.channel === 'SMS_DAILY')
        );
        if (configured === undefined) return [];
        const channelUsable =
          occurrence.channel === 'TASK' ||
          (occurrence.channel === 'SMS'
            ? smsChannel !== undefined
            : row.contact.email !== null);
        const eligibility = evaluateEligibility({
          type: row.invoice.type,
          status: row.invoice.status,
          amountDue: row.invoice.amountDue,
          contactActive: row.contact.active,
          invoicePaused,
          customerPaused,
          sequencePaused,
          channelUsable,
          channelSuppressed: channelSuppressions.some(
            (suppression) =>
              suppression.channel === occurrence.channel &&
              suppression.normalisedDestination ===
                (occurrence.channel === 'SMS'
                  ? smsChannel?.normalisedValue
                  : row.contact.email)
          ),
          stageCompleted: false
        });
        if (
          Number(row.invoice.amountDue) < Number(sequence.minimumBalance) ||
          openDisputes.length > 0 ||
          promiseActive ||
          !eligibility.eligible
        ) {
          summary.skippedOccurrences += 1;
          return [];
        }
        return [{ occurrence, configured }];
      });
      const currentOccurrenceKeys = new Set(
        eligibleOccurrences.map(
          ({ occurrence }) =>
            `${sequence.versionId}:${occurrence.stageId}:${occurrence.channel}:${new Date(occurrence.scheduledAtUtc).getTime().toString()}`
        )
      );
      await dependencies.database.transaction(async (transaction) => {
        const pendingForChase = await transaction
          .select({
            approvalId: approvals.id,
            stageId: stageInstances.id,
            sequenceVersionId: stageInstances.sequenceVersionId,
            stageKey: stageInstances.stageKey,
            channel: stageInstances.channel,
            scheduledAt: stageInstances.scheduledAt
          })
          .from(approvals)
          .innerJoin(
            stageInstances,
            and(
              eq(stageInstances.id, approvals.stageInstanceId),
              eq(stageInstances.organisationId, organisationId),
              eq(stageInstances.invoiceChaseId, chaseId)
            )
          )
          .where(
            and(
              eq(approvals.organisationId, organisationId),
              eq(approvals.status, 'PENDING')
            )
          )
          .for('update');
        const obsoletePending = pendingForChase.filter(
          (pending) =>
            pending.stageKey !== 'manual' &&
            !currentOccurrenceKeys.has(
              `${pending.sequenceVersionId}:${pending.stageKey}:${pending.channel}:${pending.scheduledAt.getTime().toString()}`
            )
        );
        if (obsoletePending.length === 0) return;
        const expired = await transaction
          .update(approvals)
          .set({ status: 'EXPIRED' })
          .where(
            and(
              eq(approvals.organisationId, organisationId),
              eq(approvals.status, 'PENDING'),
              inArray(
                approvals.id,
                obsoletePending.map((pending) => pending.approvalId)
              )
            )
          )
          .returning({ stageId: approvals.stageInstanceId });
        if (expired.length > 0) {
          await transaction
            .update(stageInstances)
            .set({ status: 'CANCELLED', updatedAt: now })
            .where(
              inArray(
                stageInstances.id,
                expired.map((pending) => pending.stageId)
              )
            );
        }
      });
      let onlineInvoiceUrl = row.invoice.onlineInvoiceUrl;

      for (const { occurrence, configured } of eligibleOccurrences) {
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
