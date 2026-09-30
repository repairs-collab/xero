import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  invoiceChases,
  organisations,
  PostgresOrganisationSafetyRepository,
  reminderSequences,
  reminderSequenceVersions,
  stageInstances
} from '@bc5000/db';
import { localDateInterval } from '@bc5000/domain';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

import {
  calculateReminderWork,
  type CalculationSummary,
  type ReminderCalculationDependencies
} from './reminders-calculate.js';

export interface AutomaticReminderDispatchDependencies {
  database: Database;
  clock: { now(): Date };
  publisher: JobPublisher;
}

export interface AutomaticReminderDispatchSummary {
  candidateCount: number;
  queuedCount: number;
  publishedCount: number;
}

export interface ReminderCycleDependencies
  extends ReminderCalculationDependencies {
  publisher: JobPublisher;
}

export interface ReminderCycleSummary {
  calculation: CalculationSummary;
  dispatch: AutomaticReminderDispatchSummary;
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

const localTime = (instant: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')}:${part('second')}`;
};

export async function dispatchAutomaticReminderWork(
  dependencies: AutomaticReminderDispatchDependencies,
  organisationId: string
): Promise<AutomaticReminderDispatchSummary> {
  const now = dependencies.clock.now();
  const [organisation] = await dependencies.database
    .select({ timeZone: organisations.timeZone })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  if (organisation === undefined) throw new Error('Organisation was not found');

  const interval = localDateInterval(
    localDate(now, organisation.timeZone),
    organisation.timeZone
  );
  const rows = await dependencies.database
    .select({
      id: stageInstances.id,
      scheduledAt: stageInstances.scheduledAt,
      sourceVersion: stageInstances.sourceVersion,
      socialWindowStart: reminderSequenceVersions.socialWindowStart,
      socialWindowEnd: reminderSequenceVersions.socialWindowEnd
    })
    .from(stageInstances)
    .innerJoin(
      invoiceChases,
      and(
        eq(invoiceChases.organisationId, organisationId),
        eq(invoiceChases.id, stageInstances.invoiceChaseId)
      )
    )
    .innerJoin(
      reminderSequences,
      and(
        eq(reminderSequences.organisationId, organisationId),
        eq(reminderSequences.id, invoiceChases.sequenceId),
        eq(reminderSequences.mode, 'AUTOMATIC'),
        eq(reminderSequences.enabled, true)
      )
    )
    .innerJoin(
      reminderSequenceVersions,
      and(
        eq(reminderSequenceVersions.organisationId, organisationId),
        eq(reminderSequenceVersions.id, stageInstances.sequenceVersionId),
        eq(reminderSequenceVersions.sequenceId, reminderSequences.id),
        eq(reminderSequenceVersions.status, 'ACTIVE')
      )
    )
    .where(
      and(
        eq(stageInstances.organisationId, organisationId),
        inArray(stageInstances.status, ['SCHEDULED', 'QUEUED']),
        inArray(stageInstances.channel, ['SMS', 'XERO_EMAIL']),
        gte(stageInstances.scheduledAt, interval.from),
        lt(stageInstances.scheduledAt, interval.before)
      )
    )
    .orderBy(asc(stageInstances.scheduledAt), asc(stageInstances.id));

  const publishedRows =
    rows.length === 0
      ? []
      : await dependencies.database
          .select({ stageInstanceId: auditEvents.entityId })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.organisationId, organisationId),
              eq(
                auditEvents.eventType,
                'AUTOMATIC_REMINDER_JOB_PUBLISHED'
              ),
              eq(auditEvents.entityType, 'STAGE_INSTANCE'),
              inArray(
                auditEvents.entityId,
                rows.map((row) => row.id)
              )
            )
          );
  const publishedStageIds = new Set(
    publishedRows.map((row) => row.stageInstanceId)
  );
  const candidates = rows.filter((row) => {
    if (publishedStageIds.has(row.id)) return false;
    const dispatchAt = row.scheduledAt > now ? row.scheduledAt : now;
    const time = localTime(dispatchAt, organisation.timeZone);
    return time >= row.socialWindowStart && time < row.socialWindowEnd;
  });
  const safety = new PostgresOrganisationSafetyRepository(
    dependencies.database
  );
  let queuedCount = 0;
  let publishedCount = 0;

  for (const candidate of candidates) {
    const prepared = await dependencies.database.transaction(
      async (transaction) => {
        await safety.assertOperationalMutationAllowed(
          transaction,
          organisationId
        );
        const [stage] = await transaction
          .select({
            id: stageInstances.id,
            scheduledAt: stageInstances.scheduledAt,
            sourceVersion: stageInstances.sourceVersion,
            status: stageInstances.status
          })
          .from(stageInstances)
          .where(
            and(
              eq(stageInstances.organisationId, organisationId),
              eq(stageInstances.id, candidate.id),
              inArray(stageInstances.status, ['SCHEDULED', 'QUEUED'])
            )
          )
          .for('update')
          .limit(1);
        if (stage === undefined) return null;
        if (stage.status === 'SCHEDULED') {
          await transaction
            .update(stageInstances)
            .set({ status: 'QUEUED', updatedAt: now })
            .where(
              and(
                eq(stageInstances.organisationId, organisationId),
                eq(stageInstances.id, stage.id),
                eq(stageInstances.status, 'SCHEDULED')
              )
            );
        }
        return { ...stage, newlyQueued: stage.status === 'SCHEDULED' };
      }
    );
    if (prepared === null) continue;
    if (prepared.newlyQueued) queuedCount += 1;

    const singletonKey = `automatic-reminder:${prepared.id}:${prepared.sourceVersion.toString()}`;
    const jobId = await dependencies.publisher.publish(
      jobNames.reminderExecute,
      { organisationId, stageInstanceId: prepared.id },
      {
        singletonKey,
        startAfter: prepared.scheduledAt > now ? prepared.scheduledAt : now,
        deduplicateWhileActive: true
      }
    );
    await dependencies.database.insert(auditEvents).values({
      organisationId,
      eventType: 'AUTOMATIC_REMINDER_JOB_PUBLISHED',
      entityType: 'STAGE_INSTANCE',
      entityId: prepared.id,
      correlationId: singletonKey,
      afterValue: {
        jobId,
        scheduledAt: prepared.scheduledAt.toISOString(),
        sourceVersion: prepared.sourceVersion
      },
      occurredAt: now
    });
    publishedCount += 1;
  }

  return {
    candidateCount: candidates.length,
    queuedCount,
    publishedCount
  };
}

export async function runReminderCycle(
  dependencies: ReminderCycleDependencies,
  organisationId: string
): Promise<ReminderCycleSummary> {
  const calculation = await calculateReminderWork(
    {
      database: dependencies.database,
      clock: dependencies.clock,
      xero: dependencies.xero
    },
    organisationId
  );
  const dispatch = await dispatchAutomaticReminderWork(
    {
      database: dependencies.database,
      clock: dependencies.clock,
      publisher: dependencies.publisher
    },
    organisationId
  );
  return { calculation, dispatch };
}
