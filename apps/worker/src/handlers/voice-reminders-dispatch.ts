import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql
} from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  organisations,
  organisationVoiceSettings,
  type PostgresVoiceCallRepository,
  reminderSequences,
  reminderSequenceVersions,
  voiceCallRequests
} from '@bc5000/db';
import { nextVoiceDispatchAt } from '@bc5000/domain';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

export type VoiceDispatchSummary =
  | { status: 'DISPATCHED'; voiceCallId: string }
  | {
      status: 'DEFERRED';
      voiceCallId: string;
      nextDispatchAt: Date;
    }
  | {
      status: 'BLOCKED';
      reason:
        | 'DEPLOYMENT_DISABLED'
        | 'ORGANISATION_CALL_IN_FLIGHT'
        | 'UNKNOWN_OUTCOME'
        | 'RUN_CAP_REACHED';
    }
  | { status: 'IDLE' };

export interface VoiceReminderDispatchDependencies {
  database: Database;
  repository: PostgresVoiceCallRepository;
  clock: { now(): Date };
  holidays: { list(organisationId: string): readonly string[] };
  publisher: JobPublisher;
  acceptCustomerVoiceCalls: boolean;
}

const configurationInteger = (
  configuration: Record<string, unknown>,
  key: 'maxCallsPerRun' | 'cooldownSeconds',
  fallback: number
): number => {
  const value = configuration[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
};

export async function dispatchDueVoiceReminders(
  dependencies: VoiceReminderDispatchDependencies,
  organisationId: string
): Promise<VoiceDispatchSummary> {
  if (!dependencies.acceptCustomerVoiceCalls) {
    return { status: 'BLOCKED', reason: 'DEPLOYMENT_DISABLED' };
  }
  const now = dependencies.clock.now();
  const selected = await dependencies.database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${organisationId}, 0))`
      );

      const [organisation] = await transaction
        .select()
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .for('update')
        .limit(1);
      const [settings] = await transaction
        .select()
        .from(organisationVoiceSettings)
        .where(eq(organisationVoiceSettings.organisationId, organisationId))
        .for('update')
        .limit(1);
      if (
        organisation === undefined ||
        settings === undefined ||
        organisation.maintenanceMode ||
        !['READY', 'RECONCILED'].includes(organisation.operationalState) ||
        organisation.sendMode !== 'live' ||
        organisation.rolloutScope !== 'CUSTOMER' ||
        !organisation.liveSendAcknowledged ||
        !settings.enabled
      ) {
        return { summary: { status: 'IDLE' } as VoiceDispatchSummary };
      }

      const [blocking] = await transaction
        .select({
          id: voiceCallRequests.id,
          state: voiceCallRequests.state
        })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, organisationId),
            eq(voiceCallRequests.purpose, 'CUSTOMER'),
            inArray(voiceCallRequests.state, [
              'SUBMITTING',
              'ACCEPTED',
              'IN_PROGRESS',
              'UNKNOWN'
            ])
          )
        )
        .orderBy(asc(voiceCallRequests.createdAt))
        .limit(1);
      if (blocking !== undefined) {
        return {
          summary: {
            status: 'BLOCKED',
            reason:
              blocking.state === 'UNKNOWN'
                ? 'UNKNOWN_OUTCOME'
                : 'ORGANISATION_CALL_IN_FLIGHT'
          } as VoiceDispatchSummary
        };
      }

      const [queuedCall] = await transaction
        .select({
          id: voiceCallRequests.id,
          idempotencyKey: voiceCallRequests.idempotencyKey
        })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, organisationId),
            eq(voiceCallRequests.purpose, 'CUSTOMER'),
            eq(voiceCallRequests.state, 'QUEUED'),
            ne(voiceCallRequests.source, 'MANUAL')
          )
        )
        .orderBy(
          asc(voiceCallRequests.queuedAt),
          asc(voiceCallRequests.createdAt),
          asc(voiceCallRequests.id)
        )
        .limit(1);
      if (queuedCall !== undefined) {
        return {
          summary: {
            status: 'DISPATCHED',
            voiceCallId: queuedCall.id
          } as VoiceDispatchSummary,
          job: {
            voiceCallId: queuedCall.id,
            correlationId: queuedCall.idempotencyKey
          }
        };
      }

      const candidates = await transaction
        .select({
          id: voiceCallRequests.id,
          actorUserId: voiceCallRequests.actorUserId,
          source: voiceCallRequests.source,
          sequenceVersionId: voiceCallRequests.sequenceVersionId,
          stageKey: voiceCallRequests.stageKey,
          localOccurrenceDate: voiceCallRequests.localOccurrenceDate,
          idempotencyKey: voiceCallRequests.idempotencyKey,
          configuration: reminderSequenceVersions.configuration
        })
        .from(voiceCallRequests)
        .innerJoin(
          reminderSequences,
          and(
            eq(reminderSequences.id, voiceCallRequests.sequenceId),
            eq(reminderSequences.organisationId, organisationId),
            eq(reminderSequences.kind, 'VOICE'),
            eq(reminderSequences.enabled, true)
          )
        )
        .innerJoin(
          reminderSequenceVersions,
          and(
            eq(
              reminderSequenceVersions.id,
              voiceCallRequests.sequenceVersionId
            ),
            eq(reminderSequenceVersions.organisationId, organisationId),
            eq(reminderSequenceVersions.status, 'ACTIVE')
          )
        )
        .where(
          and(
            eq(voiceCallRequests.organisationId, organisationId),
            eq(voiceCallRequests.purpose, 'CUSTOMER'),
            eq(voiceCallRequests.state, 'APPROVED'),
            ne(voiceCallRequests.source, 'MANUAL'),
            lte(voiceCallRequests.scheduledAt, now),
            or(
              and(
                eq(voiceCallRequests.source, 'SEQUENCE_REVIEW'),
                eq(reminderSequences.mode, 'REVIEW')
              ),
              settings.automaticEnabled
                ? and(
                    eq(
                      voiceCallRequests.source,
                      'SEQUENCE_AUTOMATIC'
                    ),
                    eq(reminderSequences.mode, 'AUTOMATIC')
                  )
                : undefined
            )
          )
        )
        .orderBy(
          asc(voiceCallRequests.scheduledAt),
          asc(voiceCallRequests.createdAt),
          asc(voiceCallRequests.id)
        );
      if (candidates.length === 0) {
        return { summary: { status: 'IDLE' } as VoiceDispatchSummary };
      }

      const [lastTerminal] = await transaction
        .select({ completedAt: voiceCallRequests.completedAt })
        .from(voiceCallRequests)
        .where(
          and(
            eq(voiceCallRequests.organisationId, organisationId),
            eq(voiceCallRequests.purpose, 'CUSTOMER'),
            inArray(voiceCallRequests.state, [
              'COMPLETED',
              'CANCELLED',
              'FAILED'
            ]),
            isNotNull(voiceCallRequests.completedAt)
          )
        )
        .orderBy(desc(voiceCallRequests.completedAt))
        .limit(1);

      let capReached = false;
      for (const candidate of candidates) {
        if (
          candidate.sequenceVersionId === null ||
          candidate.stageKey === null ||
          candidate.localOccurrenceDate === null
        ) {
          continue;
        }
        const maxCallsPerRun = configurationInteger(
          candidate.configuration,
          'maxCallsPerRun',
          5
        );
        const [usage] = await transaction
          .select({ value: count() })
          .from(voiceCallRequests)
          .where(
            and(
              eq(voiceCallRequests.organisationId, organisationId),
              eq(
                voiceCallRequests.sequenceVersionId,
                candidate.sequenceVersionId
              ),
              eq(voiceCallRequests.stageKey, candidate.stageKey),
              eq(
                voiceCallRequests.localOccurrenceDate,
                candidate.localOccurrenceDate
              ),
              isNotNull(voiceCallRequests.queuedAt)
            )
          );
        if ((usage?.value ?? 0) >= maxCallsPerRun) {
          capReached = true;
          continue;
        }

        const cooldownSeconds = configurationInteger(
          candidate.configuration,
          'cooldownSeconds',
          120
        );
        const nextDispatchAt = nextVoiceDispatchAt({
          requestedAt: now,
          lastCompletedAt: lastTerminal?.completedAt ?? null,
          cooldownSeconds,
          timezone: settings.timezone,
          holidays: [...dependencies.holidays.list(organisationId)],
          weekdayStartLocal: settings.weekdayStartLocal.slice(0, 5),
          weekdayEndLocal: settings.weekdayEndLocal.slice(0, 5)
        });
        if (nextDispatchAt.getTime() > now.getTime()) {
          return {
            summary: {
              status: 'DEFERRED',
              voiceCallId: candidate.id,
              nextDispatchAt
            } as VoiceDispatchSummary
          };
        }

        const queued = await dependencies.repository.queueApprovedScheduledCall(
          {
            organisationId,
            voiceCallId: candidate.id,
            now
          },
          transaction
        );
        if (!queued.queued) continue;
        await transaction.insert(auditEvents).values({
          organisationId,
          actorUserId: candidate.actorUserId,
          eventType: 'VOICE_REMINDER_QUEUED',
          entityType: 'VOICE_CALL',
          entityId: candidate.id,
          correlationId: candidate.idempotencyKey,
          afterValue: {
            state: 'QUEUED',
            source: candidate.source,
            sequenceVersionId: candidate.sequenceVersionId,
            stageKey: candidate.stageKey,
            localOccurrenceDate: candidate.localOccurrenceDate
          },
          occurredAt: now
        });
        return {
          summary: {
            status: 'DISPATCHED',
            voiceCallId: candidate.id
          } as VoiceDispatchSummary,
          job: {
            voiceCallId: candidate.id,
            correlationId: candidate.idempotencyKey
          }
        };
      }

      return {
        summary: capReached
          ? ({ status: 'BLOCKED', reason: 'RUN_CAP_REACHED' } as const)
          : ({ status: 'IDLE' } as const)
      };
    }
  );

  if (selected.job !== undefined) {
    await dependencies.publisher.publish(
      jobNames.voiceCallExecute,
      {
        organisationId,
        voiceCallId: selected.job.voiceCallId,
        provider: 'VOIPCLOUD',
        correlationId: selected.job.correlationId
      },
      {
        singletonKey: `${jobNames.voiceCallExecute}:${selected.job.voiceCallId}`,
        deduplicateWhileActive: true
      }
    );
  }
  return selected.summary;
}
