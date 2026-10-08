import { createHash } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { authorise, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  type Database,
  type DbTransaction,
  organisationVoiceSettings
} from '@bc5000/db/web';
import { fixedVoiceCallCopy } from '@bc5000/domain';

type VoiceExecutor = Database | DbTransaction;
type VoiceSettingsRow = typeof organisationVoiceSettings.$inferSelect;

const connectionEvidenceLifetimeMs = 24 * 60 * 60 * 1000;
const e164Pattern = /^\+[1-9]\d{7,14}$/;
const localTimePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const secretReferencePattern = /^(?:env:)?[A-Za-z_][A-Za-z0-9_.:/-]{2,127}$/;
const sipPattern = /^sips?:[^\s@]+@[^\s@]+$/i;

export const voiceCallFlowHash = `sha256:${createHash('sha256')
  .update(JSON.stringify(fixedVoiceCallCopy))
  .digest('hex')}`;

export interface SaveVoiceSettingsInput {
  organisationId: string;
  provider: 'RETELL';
  secretReference: string;
  previewPublicKey: string;
  agentId: string;
  agentVersion: number;
  voiceId: string;
  voiceLabel: string;
  outboundNumber: string;
  transferSipUri: string | null;
  fallbackOfficeNumber: string;
  officeDestinationLabel: string;
  timezone: string;
  weekdayStartLocal: string;
  weekdayEndLocal: string;
}

export interface SetVoiceEnabledInput {
  organisationId: string;
  enabled: boolean;
  confirmation?: string;
}

export interface TestVoiceConnectionInput {
  organisationId: string;
}

export interface RecordGenericFlowTestInput {
  organisationId: string;
  previewSessionToken: string;
}

export interface VoiceProviderConnectionResult {
  authenticated: boolean;
  agentVersionAvailable: boolean;
  voiceAvailable: boolean;
  previewKeyDomainRestricted: boolean;
  recaptchaProtection: 'enabled' | 'unsupported' | 'disabled';
  recordingDisabled: boolean;
}

export interface VoiceProviderTester {
  test(input: {
    organisationId: string;
    provider: 'RETELL';
    secretReference: string;
    previewPublicKey: string;
    agentId: string;
    agentVersion: number;
    voiceId: string;
  }): Promise<VoiceProviderConnectionResult>;
}

export interface VoicePreviewSessionVerifier {
  verify(input: {
    organisationId: string;
    userId: string;
    previewSessionToken: string;
    callFlowHash: string;
    callFlowVersion: number;
    configurationVersion: number;
    agentId: string;
    agentVersion: number;
    voiceId: string;
  }): Promise<{ sessionId: string; passed: boolean }>;
}

export interface VoiceSettingsView {
  configured: boolean;
  enabled: boolean;
  provider: 'RETELL' | 'VOIPCLOUD';
  secretReferenceLabel: string | null;
  previewPublicKey: string | null;
  agentId: string | null;
  agentVersion: number | null;
  voiceId: string | null;
  voiceLabel: string | null;
  outboundNumber: string | null;
  transferSipUri: string | null;
  fallbackOfficeNumber: string | null;
  officeDestinationLabel: string | null;
  timezone: string;
  weekdayStartLocal: string;
  weekdayEndLocal: string;
  configurationVersion: number;
  callFlowVersion: number;
  callFlowHash: string;
  connectionReady: boolean;
  genericFlowReady: boolean;
  lastConnectionTestedAt: Date | null;
}

export interface VoiceConnectionTestResult
  extends VoiceProviderConnectionResult {
  healthy: boolean;
}

export interface GenericFlowTestResult {
  sessionId: string;
  passed: true;
  callFlowHash: string;
  callFlowVersion: number;
}

export interface VoiceSettingsServiceDependencies {
  database: Database;
  session: AppSession;
  tester: VoiceProviderTester;
  previewSessions: VoicePreviewSessionVerifier;
  clock: { now(): Date };
}

const loadSettings = async (
  executor: VoiceExecutor,
  organisationId: string,
  lock = false
): Promise<VoiceSettingsRow | null> => {
  let query = executor
    .select()
    .from(organisationVoiceSettings)
    .where(eq(organisationVoiceSettings.organisationId, organisationId))
    .limit(1);
  if (lock) query = query.for('update') as typeof query;
  const [settings] = await query;
  return settings ?? null;
};

const validTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

const minutes = (value: string): number | null => {
  const match = localTimePattern.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const validate = (input: SaveVoiceSettingsInput): void => {
  const start = minutes(input.weekdayStartLocal);
  const end = minutes(input.weekdayEndLocal);
  const transferSipUri = input.transferSipUri?.trim() || null;
  if (
    input.provider !== 'RETELL' ||
    !secretReferencePattern.test(input.secretReference) ||
    /^key_/i.test(input.secretReference) ||
    !/^public_key_[A-Za-z0-9_-]{6,}$/.test(input.previewPublicKey) ||
    input.agentId.trim() === '' ||
    !Number.isInteger(input.agentVersion) ||
    input.agentVersion < 0 ||
    input.voiceId.trim() === '' ||
    input.voiceLabel.trim() === '' ||
    !e164Pattern.test(input.outboundNumber) ||
    (transferSipUri !== null && !sipPattern.test(transferSipUri)) ||
    !e164Pattern.test(input.fallbackOfficeNumber) ||
    input.officeDestinationLabel.trim() === '' ||
    !validTimezone(input.timezone) ||
    start === null ||
    end === null ||
    start >= end
  ) {
    throw new Error('VOICE_SETTINGS_INVALID');
  }
};

const safeReferenceLabel = (reference: string | null): string | null => {
  if (reference === null) return null;
  const withoutScheme = reference.replace(/^env:/, '');
  return withoutScheme.split(/[/:]/).at(-1) ?? withoutScheme;
};

const persistedFields = [
  'provider',
  'secretReference',
  'previewPublicKey',
  'agentId',
  'agentVersion',
  'voiceId',
  'voiceLabel',
  'outboundNumber',
  'transferSipUri',
  'fallbackOfficeNumber',
  'officeDestinationLabel',
  'timezone',
  'weekdayStartLocal',
  'weekdayEndLocal'
] as const;

const changedFields = (
  before: VoiceSettingsRow | null,
  input: SaveVoiceSettingsInput
): string[] =>
  persistedFields.filter((field) => {
    const next = field === 'transferSipUri'
      ? input.transferSipUri?.trim() || null
      : input[field];
    return before === null || before[field] !== next;
  });

const connectionReady = (
  settings: VoiceSettingsRow,
  now: Date
): boolean =>
  settings.lastConnectionTestSucceeded &&
  settings.lastConnectionTestedAt !== null &&
  now.getTime() - settings.lastConnectionTestedAt.getTime() <=
    connectionEvidenceLifetimeMs;

const latestGenericFlowEvidence = async (
  executor: VoiceExecutor,
  settings: VoiceSettingsRow
): Promise<boolean> => {
  const events = await executor
    .select({
      afterValue: auditEvents.afterValue,
      occurredAt: auditEvents.occurredAt
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organisationId, settings.organisationId),
        eq(auditEvents.eventType, 'VOICE_GENERIC_FLOW_TESTED'),
        eq(auditEvents.entityType, 'ORGANISATION_VOICE_SETTINGS'),
        eq(auditEvents.entityId, settings.organisationId)
      )
    )
    .orderBy(desc(auditEvents.occurredAt))
    .limit(1);
  const evidenceEvent = events[0];
  const evidence = evidenceEvent?.afterValue;
  return (
    evidenceEvent !== undefined &&
    evidence?.configurationVersion === settings.configurationVersion &&
    evidence?.passed === true &&
    evidence.callFlowHash === voiceCallFlowHash &&
    evidence.callFlowVersion === fixedVoiceCallCopy.version &&
    evidence.agentId === settings.agentId &&
    evidence.agentVersion === settings.agentVersion &&
    evidence.voiceId === settings.voiceId
  );
};

const toView = async (
  executor: VoiceExecutor,
  settings: VoiceSettingsRow | null,
  now: Date,
  fallbackTimezone = 'Australia/Sydney'
): Promise<VoiceSettingsView> => {
  if (settings === null) {
    return {
      configured: false,
      enabled: false,
      provider: 'RETELL',
      secretReferenceLabel: null,
      previewPublicKey: null,
      agentId: null,
      agentVersion: null,
      voiceId: null,
      voiceLabel: null,
      outboundNumber: null,
      transferSipUri: null,
      fallbackOfficeNumber: null,
      officeDestinationLabel: null,
      timezone: fallbackTimezone,
      weekdayStartLocal: '09:00',
      weekdayEndLocal: '17:00',
      configurationVersion: 0,
      callFlowVersion: fixedVoiceCallCopy.version,
      callFlowHash: voiceCallFlowHash,
      connectionReady: false,
      genericFlowReady: false,
      lastConnectionTestedAt: null
    };
  }
  return {
    configured: true,
    enabled: settings.enabled,
    provider: settings.provider,
    secretReferenceLabel: safeReferenceLabel(settings.secretReference),
    previewPublicKey: settings.previewPublicKey,
    agentId: settings.agentId,
    agentVersion: settings.agentVersion,
    voiceId: settings.voiceId,
    voiceLabel: settings.voiceLabel,
    outboundNumber: settings.outboundNumber,
    transferSipUri: settings.transferSipUri,
    fallbackOfficeNumber: settings.fallbackOfficeNumber,
    officeDestinationLabel: settings.officeDestinationLabel,
    timezone: settings.timezone,
    weekdayStartLocal: settings.weekdayStartLocal,
    weekdayEndLocal: settings.weekdayEndLocal,
    configurationVersion: settings.configurationVersion,
    callFlowVersion: fixedVoiceCallCopy.version,
    callFlowHash: voiceCallFlowHash,
    connectionReady: connectionReady(settings, now),
    genericFlowReady: await latestGenericFlowEvidence(executor, settings),
    lastConnectionTestedAt: settings.lastConnectionTestedAt
  };
};

export const readVoiceSettingsView = (
  database: Database,
  organisationId: string,
  now: Date
): Promise<VoiceSettingsView> =>
  loadSettings(database, organisationId).then((settings) =>
    toView(database, settings, now)
  );

export function createVoiceSettingsService(
  dependencies: VoiceSettingsServiceDependencies
) {
  const get = async (organisationId: string): Promise<VoiceSettingsView> => {
    authorise(
      dependencies.session,
      'voice-settings.manage',
      organisationId
    );
    const settings = await loadSettings(dependencies.database, organisationId);
    return toView(
      dependencies.database,
      settings,
      dependencies.clock.now()
    );
  };

  const save = async (
    input: SaveVoiceSettingsInput
  ): Promise<VoiceSettingsView> => {
    authorise(
      dependencies.session,
      'voice-settings.manage',
      input.organisationId
    );
    validate(input);
    const now = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      const before = await loadSettings(
        transaction,
        input.organisationId,
        true
      );
      const changes = changedFields(before, input);
      const values = {
        organisationId: input.organisationId,
        provider: input.provider,
        secretReference: input.secretReference,
        previewPublicKey: input.previewPublicKey,
        agentId: input.agentId.trim(),
        agentVersion: input.agentVersion,
        voiceId: input.voiceId.trim(),
        voiceLabel: input.voiceLabel.trim(),
        outboundNumber: input.outboundNumber,
        transferSipUri: input.transferSipUri?.trim() || null,
        fallbackOfficeNumber: input.fallbackOfficeNumber,
        officeDestinationLabel: input.officeDestinationLabel.trim(),
        timezone: input.timezone,
        weekdayStartLocal: input.weekdayStartLocal,
        weekdayEndLocal: input.weekdayEndLocal,
        updatedByUserId: dependencies.session.userId,
        updatedAt: now,
        configurationVersion:
          changes.length === 0
            ? before?.configurationVersion ?? 0
            : (before?.configurationVersion ?? 0) + 1,
        ...(changes.length === 0
          ? {}
          : {
              enabled: false,
              lastConnectionTestedAt: null,
              lastConnectionTestSucceeded: false
            })
      };
      await transaction
        .insert(organisationVoiceSettings)
        .values(values)
        .onConflictDoUpdate({
          target: organisationVoiceSettings.organisationId,
          set: values
        });
      if (changes.length > 0) {
        await transaction.insert(auditEvents).values({
          organisationId: input.organisationId,
          actorUserId: dependencies.session.userId,
          eventType: 'VOICE_SETTINGS_CHANGED',
          entityType: 'ORGANISATION_VOICE_SETTINGS',
          entityId: input.organisationId,
          afterValue: {
            changedFields: changes,
            connectionEvidenceInvalidated: true,
            voiceDisabled: true
          },
          occurredAt: now
        });
      }
    });
    return get(input.organisationId);
  };

  const testConnection = async (
    input: TestVoiceConnectionInput
  ): Promise<VoiceConnectionTestResult> => {
    authorise(
      dependencies.session,
      'voice-settings.manage',
      input.organisationId
    );
    const settings = await loadSettings(
      dependencies.database,
      input.organisationId
    );
    if (
      settings === null ||
      settings.provider !== 'RETELL' ||
      settings.secretReference === null ||
      settings.previewPublicKey === null ||
      settings.agentId === null ||
      settings.agentVersion === null ||
      settings.voiceId === null
    ) {
      throw new Error('VOICE_SETTINGS_NOT_CONFIGURED');
    }
    const result = await dependencies.tester.test({
      organisationId: input.organisationId,
      provider: settings.provider,
      secretReference: settings.secretReference,
      previewPublicKey: settings.previewPublicKey,
      agentId: settings.agentId,
      agentVersion: settings.agentVersion,
      voiceId: settings.voiceId
    });
    const healthy =
      result.authenticated &&
      result.agentVersionAvailable &&
      result.voiceAvailable &&
      result.previewKeyDomainRestricted &&
      result.recaptchaProtection !== 'disabled' &&
      result.recordingDisabled;
    const testedAt = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(organisationVoiceSettings)
        .set({
          lastConnectionTestedAt: testedAt,
          lastConnectionTestSucceeded: healthy,
          updatedAt: testedAt
        })
        .where(
          and(
            eq(
              organisationVoiceSettings.organisationId,
              input.organisationId
            ),
            eq(organisationVoiceSettings.updatedAt, settings.updatedAt)
          )
        )
        .returning({ organisationId: organisationVoiceSettings.organisationId });
      if (updated.length === 0) {
        throw new Error('VOICE_SETTINGS_CHANGED_DURING_TEST');
      }
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: dependencies.session.userId,
        eventType: 'VOICE_CONNECTION_TESTED',
        entityType: 'ORGANISATION_VOICE_SETTINGS',
        entityId: input.organisationId,
        afterValue: { healthy, ...result },
        occurredAt: testedAt
      });
    });
    return { healthy, ...result };
  };

  const recordGenericFlowTest = async (
    input: RecordGenericFlowTestInput
  ): Promise<GenericFlowTestResult> => {
    authorise(
      dependencies.session,
      'voice-settings.manage',
      input.organisationId
    );
    const settings = await loadSettings(
      dependencies.database,
      input.organisationId
    );
    if (
      settings === null ||
      settings.agentId === null ||
      settings.agentVersion === null ||
      settings.voiceId === null
    ) {
      throw new Error('VOICE_SETTINGS_NOT_CONFIGURED');
    }
    const verified = await dependencies.previewSessions.verify({
      organisationId: input.organisationId,
      userId: dependencies.session.userId,
      previewSessionToken: input.previewSessionToken,
      callFlowHash: voiceCallFlowHash,
      callFlowVersion: fixedVoiceCallCopy.version,
      configurationVersion: settings.configurationVersion,
      agentId: settings.agentId,
      agentVersion: settings.agentVersion,
      voiceId: settings.voiceId
    });
    if (!verified.passed) throw new Error('VOICE_PREVIEW_NOT_VERIFIED');
    const recordedAt = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      const current = await loadSettings(
        transaction,
        input.organisationId,
        true
      );
      if (
        current === null ||
        current.updatedAt.getTime() !== settings.updatedAt.getTime()
      ) {
        throw new Error('VOICE_SETTINGS_CHANGED_DURING_PREVIEW');
      }
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: dependencies.session.userId,
        eventType: 'VOICE_GENERIC_FLOW_TESTED',
        entityType: 'ORGANISATION_VOICE_SETTINGS',
        entityId: input.organisationId,
        correlationId: verified.sessionId,
        afterValue: {
          passed: true,
          sessionId: verified.sessionId,
          configurationVersion: settings.configurationVersion,
          callFlowHash: voiceCallFlowHash,
          callFlowVersion: fixedVoiceCallCopy.version,
          agentId: settings.agentId,
          agentVersion: settings.agentVersion,
          voiceId: settings.voiceId,
          fictionalDataOnly: true,
          previewMode: true
        },
        occurredAt: recordedAt
      });
    });
    return {
      sessionId: verified.sessionId,
      passed: true,
      callFlowHash: voiceCallFlowHash,
      callFlowVersion: fixedVoiceCallCopy.version
    };
  };

  const setEnabled = async (
    input: SetVoiceEnabledInput
  ): Promise<VoiceSettingsView> => {
    authorise(
      dependencies.session,
      'voice-settings.manage',
      input.organisationId
    );
    if (input.enabled && input.confirmation !== 'ENABLE VOICE CALLS') {
      throw new Error('VOICE_ENABLE_CONFIRMATION_REQUIRED');
    }
    const changedAt = dependencies.clock.now();
    await dependencies.database.transaction(async (transaction) => {
      const settings = await loadSettings(
        transaction,
        input.organisationId,
        true
      );
      if (settings === null) throw new Error('VOICE_SETTINGS_NOT_CONFIGURED');
      if (
        input.enabled &&
        (!connectionReady(settings, changedAt) ||
          !(await latestGenericFlowEvidence(transaction, settings)))
      ) {
        throw new Error('VOICE_SETTINGS_NOT_READY');
      }
      await transaction
        .update(organisationVoiceSettings)
        .set({
          enabled: input.enabled,
          updatedByUserId: dependencies.session.userId,
          updatedAt: changedAt
        })
        .where(
          eq(
            organisationVoiceSettings.organisationId,
            input.organisationId
          )
        );
      await transaction.insert(auditEvents).values({
        organisationId: input.organisationId,
        actorUserId: dependencies.session.userId,
        eventType: input.enabled
          ? 'VOICE_MANUAL_CALLS_ENABLED'
          : 'VOICE_MANUAL_CALLS_DISABLED',
        entityType: 'ORGANISATION_VOICE_SETTINGS',
        entityId: input.organisationId,
        afterValue: {
          enabled: input.enabled,
          scope: 'MANUAL_ONE_AT_A_TIME',
          customerLiveUnaffected: true
        },
        occurredAt: changedAt
      });
    });
    return get(input.organisationId);
  };

  return {
    get,
    save,
    setEnabled,
    testConnection,
    recordGenericFlowTest
  };
}
