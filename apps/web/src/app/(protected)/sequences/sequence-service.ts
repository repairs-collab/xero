import { and, eq, max } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import { auditEvents, type Database, reminderSequences, reminderSequenceVersions, sequenceExclusions, sequenceStages } from '@bc5000/db/web';
import { validateSmsTemplate, type DailyBasis, type ReminderStageChannel, type SmsAggregationStrategy } from '@bc5000/domain';

export interface SequenceDraftStage {
  key: string;
  offsetDays: number;
  channels: ReminderStageChannel[];
  template?: string;
}

export interface SequenceDraft {
  organisationId: string;
  sequenceId: string;
  dailyBasis: DailyBasis;
  smsAggregation: SmsAggregationStrategy;
  sendTime: string;
  socialWindowStart: string;
  socialWindowEnd: string;
  minimumBalance: string;
  maxSmsSegments: number;
  xeroEmailAfterSmsOptOut: boolean;
  allowedCurrencies: string[];
  exclusions: { kind: string; value: string }[];
  stages: SequenceDraftStage[];
}

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateSequenceDraft(draft: SequenceDraft): void {
  if (draft.stages.length === 0) throw new Error('SEQUENCE_REQUIRES_STAGE');
  if (!timePattern.test(draft.sendTime) || !timePattern.test(draft.socialWindowStart) || !timePattern.test(draft.socialWindowEnd)) throw new Error('INVALID_TIME');
  if (draft.socialWindowStart >= draft.socialWindowEnd) throw new Error('INVALID_SOCIAL_WINDOW');
  if (draft.sendTime < draft.socialWindowStart || draft.sendTime >= draft.socialWindowEnd) throw new Error('SEND_TIME_OUTSIDE_SOCIAL_WINDOW');
  if (!Number.isFinite(Number(draft.minimumBalance)) || Number(draft.minimumBalance) < 0) throw new Error('INVALID_MINIMUM_BALANCE');
  if (!Number.isInteger(draft.maxSmsSegments) || draft.maxSmsSegments < 1 || draft.maxSmsSegments > 10) throw new Error('INVALID_SEGMENT_LIMIT');
  if (draft.smsAggregation === 'CONSOLIDATED_CUSTOMER' && new Set(draft.allowedCurrencies).size > 1) throw new Error('MIXED_CURRENCY_CONSOLIDATION');
  const occurrences = new Set<string>();
  for (const stage of draft.stages) {
    if (stage.key.trim() === '' || !Number.isInteger(stage.offsetDays) || stage.offsetDays < 0 || stage.channels.length === 0) throw new Error('INVALID_STAGE');
    for (const channel of stage.channels) {
      const occurrence = `${stage.offsetDays}:${channel}`;
      if (occurrences.has(occurrence)) throw new Error('DUPLICATE_OFFSET_CHANNEL');
      occurrences.add(occurrence);
      if ((channel === 'SMS' || channel === 'SMS_DAILY') && (stage.template === undefined || stage.template.trim() === '')) throw new Error('SMS_TEMPLATE_REQUIRED');
    }
    if (stage.template !== undefined) validateSmsTemplate(stage.template);
  }
}

export function createSequenceService(dependencies: { database: Database; clock: { now(): Date } }) {
  const setSequenceMode = async (session: AppSession, input: { organisationId: string; sequenceId: string; mode: 'REVIEW' | 'AUTOMATIC' }): Promise<void> => {
    authorise(session, input.mode === 'AUTOMATIC' ? 'sequence.set-automatic' : 'sequence.manage', input.organisationId);
    const now = dependencies.clock.now();
    const changed = await dependencies.database.update(reminderSequences).set({ mode: input.mode, updatedAt: now }).where(and(eq(reminderSequences.organisationId, input.organisationId), eq(reminderSequences.id, input.sequenceId))).returning({ id: reminderSequences.id });
    if (changed.length === 0) throw new Error('SEQUENCE_NOT_FOUND');
    await dependencies.database.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'SEQUENCE_MODE_CHANGED', entityType: 'SEQUENCE', entityId: input.sequenceId, afterValue: { mode: input.mode }, occurredAt: now });
  };

  const createStandardSequence = async (session: AppSession, input: { organisationId: string }): Promise<{ sequenceId: string; created: boolean }> => {
    authorise(session, 'sequence.manage', input.organisationId);
    const now = dependencies.clock.now();
    const stages: SequenceDraftStage[] = [
      { key: 'due-date', offsetDays: 0, channels: ['SMS'], template: 'Hi {{customer_name}}, invoice {{invoice_number}} is due today. Amount due: {{amount_due}}.' },
      { key: 'seven-days', offsetDays: 7, channels: ['XERO_EMAIL', 'SMS'], template: 'Hi {{customer_name}}, invoice {{invoice_number}} is now 7 days overdue. Amount due: {{amount_due}}.' },
      { key: 'twenty-one-days', offsetDays: 21, channels: ['SMS'], template: 'Final warning: invoice {{invoice_number}} remains overdue. Please arrange payment or contact us today.' },
      { key: 'thirty-days', offsetDays: 30, channels: ['TASK', 'SMS_DAILY'], template: 'Invoice {{invoice_number}} remains overdue. Please contact us today to avoid further escalation.' }
    ];
    validateSequenceDraft({ organisationId: input.organisationId, sequenceId: 'standard', dailyBasis: 'BUSINESS_DAYS', smsAggregation: 'CONSOLIDATED_CUSTOMER', sendTime: '09:00', socialWindowStart: '08:00', socialWindowEnd: '18:00', minimumBalance: '0', maxSmsSegments: 3, xeroEmailAfterSmsOptOut: true, allowedCurrencies: ['AUD'], exclusions: [], stages });
    return dependencies.database.transaction(async (transaction) => {
      const [createdSequence] = await transaction.insert(reminderSequences).values({ organisationId: input.organisationId, name: 'Standard bill chasing', mode: 'REVIEW', enabled: true, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: [reminderSequences.organisationId, reminderSequences.name] }).returning({ id: reminderSequences.id });
      if (createdSequence === undefined) {
        const [existing] = await transaction.select({ id: reminderSequences.id }).from(reminderSequences).where(and(eq(reminderSequences.organisationId, input.organisationId), eq(reminderSequences.name, 'Standard bill chasing'))).limit(1);
        if (existing === undefined) throw new Error('STANDARD_SEQUENCE_NOT_FOUND');
        return { sequenceId: existing.id, created: false };
      }
      const [version] = await transaction.insert(reminderSequenceVersions).values({ organisationId: input.organisationId, sequenceId: createdSequence.id, versionNumber: 1, status: 'ACTIVE', dailyBasis: 'BUSINESS_DAYS', smsAggregation: 'CONSOLIDATED_CUSTOMER', sendTime: '09:00:00', socialWindowStart: '08:00:00', socialWindowEnd: '18:00:00', minimumBalance: '0', maxSmsSegments: 3, xeroEmailAfterSmsOptOut: true, configuration: { allowedCurrencies: ['AUD'] }, activatedAt: now, createdByUserId: session.userId, createdAt: now }).returning({ id: reminderSequenceVersions.id });
      if (version === undefined) throw new Error('SEQUENCE_VERSION_NOT_CREATED');
      await transaction.insert(sequenceStages).values(stages.flatMap((stage) => stage.channels.map((channel) => ({ organisationId: input.organisationId, sequenceVersionId: version.id, stageKey: stage.key, offsetDays: stage.offsetDays, channel, template: stage.template ?? null }))));
      await transaction.insert(auditEvents).values({ organisationId: input.organisationId, actorUserId: session.userId, eventType: 'STANDARD_SEQUENCE_CREATED', entityType: 'SEQUENCE', entityId: createdSequence.id, afterValue: { mode: 'REVIEW', versionNumber: 1, dailyBasis: 'BUSINESS_DAYS' }, occurredAt: now });
      return { sequenceId: createdSequence.id, created: true };
    });
  };

  const persistVersion = async (session: AppSession, draft: SequenceDraft, status: 'DRAFT' | 'ACTIVE') => {
    authorise(session, 'sequence.manage', draft.organisationId);
    validateSequenceDraft(draft);
    const now = dependencies.clock.now();
    return dependencies.database.transaction(async (transaction) => {
      const [sequence] = await transaction.select({ id: reminderSequences.id }).from(reminderSequences).where(and(eq(reminderSequences.organisationId, draft.organisationId), eq(reminderSequences.id, draft.sequenceId))).for('update').limit(1);
      if (sequence === undefined) throw new Error('SEQUENCE_NOT_FOUND');
      const [latest] = await transaction.select({ value: max(reminderSequenceVersions.versionNumber) }).from(reminderSequenceVersions).where(and(eq(reminderSequenceVersions.organisationId, draft.organisationId), eq(reminderSequenceVersions.sequenceId, draft.sequenceId)));
      const versionNumber = (latest?.value ?? 0) + 1;
      if (status === 'ACTIVE') await transaction.update(reminderSequenceVersions).set({ status: 'RETIRED' }).where(and(eq(reminderSequenceVersions.organisationId, draft.organisationId), eq(reminderSequenceVersions.sequenceId, draft.sequenceId), eq(reminderSequenceVersions.status, 'ACTIVE')));
      const [version] = await transaction.insert(reminderSequenceVersions).values({ organisationId: draft.organisationId, sequenceId: draft.sequenceId, versionNumber, status, dailyBasis: draft.dailyBasis, smsAggregation: draft.smsAggregation, sendTime: `${draft.sendTime}:00`, socialWindowStart: `${draft.socialWindowStart}:00`, socialWindowEnd: `${draft.socialWindowEnd}:00`, minimumBalance: draft.minimumBalance, maxSmsSegments: draft.maxSmsSegments, xeroEmailAfterSmsOptOut: draft.xeroEmailAfterSmsOptOut, configuration: { allowedCurrencies: draft.allowedCurrencies }, activatedAt: status === 'ACTIVE' ? now : null, createdByUserId: session.userId, createdAt: now }).returning({ id: reminderSequenceVersions.id });
      if (version === undefined) throw new Error('SEQUENCE_VERSION_NOT_CREATED');
      await transaction.insert(sequenceStages).values(draft.stages.flatMap((stage) => stage.channels.map((channel) => ({ organisationId: draft.organisationId, sequenceVersionId: version.id, stageKey: stage.key, offsetDays: stage.offsetDays, channel, template: stage.template ?? null }))));
      if (draft.exclusions.length > 0) await transaction.insert(sequenceExclusions).values(draft.exclusions.map((exclusion) => ({ organisationId: draft.organisationId, sequenceVersionId: version.id, kind: exclusion.kind, value: exclusion.value })));
      await transaction.insert(auditEvents).values({ organisationId: draft.organisationId, actorUserId: session.userId, eventType: status === 'ACTIVE' ? 'SEQUENCE_VERSION_ACTIVATED' : 'SEQUENCE_DRAFT_SAVED', entityType: 'SEQUENCE_VERSION', entityId: version.id, afterValue: { sequenceId: draft.sequenceId, versionNumber, status }, occurredAt: now });
      return { versionId: version.id, versionNumber, preview: { window: { days: 30 }, stages: draft.stages.map((stage) => ({ key: stage.key, offsetDays: stage.offsetDays, channels: stage.channels })) } };
    });
  };

  return {
    createStandardSequence,
    setSequenceMode,
    saveSequenceDraft: (session: AppSession, draft: SequenceDraft) => persistVersion(session, draft, 'DRAFT'),
    activateSequenceVersion: (session: AppSession, draft: SequenceDraft) => persistVersion(session, draft, 'ACTIVE')
  };
}
