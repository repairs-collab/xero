import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  organisations,
  organisationVoiceSettings,
  users
} from '@bc5000/db';

import {
  createVoiceSettingsService,
  type SaveVoiceSettingsInput,
  type VoiceProviderConnectionResult
} from '../src/app/(protected)/settings/voice/voice-settings.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-10-08T02:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seed() {
  const organisationId = randomUUID();
  const userId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Voice settings test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Voice Administrator'
  });
  const session = (role: 'ADMIN' | 'OPERATOR'): AppSession => ({
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'Voice Administrator',
    expiresAt: '2026-10-09T00:00:00.000Z',
    memberships: [{ organisationId, role, active: true }]
  });
  return { organisationId, userId, session };
}

const saveInput = (organisationId: string): SaveVoiceSettingsInput => ({
  organisationId,
  provider: 'RETELL',
  secretReference: 'env:RETELL_API_KEY',
  previewPublicKey: 'public_key_accountpulse_preview',
  agentId: 'agent_accountpulse',
  agentVersion: 7,
  voiceId: 'voice_australian_1',
  voiceLabel: 'Australian accounts voice',
  outboundNumber: '+61255501234',
  transferSipUri: 'sip:accounts@voipline.example',
  fallbackOfficeNumber: '+61255504321',
  officeDestinationLabel: 'Main office accounts queue',
  timezone: 'Australia/Sydney',
  weekdayStartLocal: '09:00',
  weekdayEndLocal: '17:00'
});

const healthyConnection: VoiceProviderConnectionResult = {
  authenticated: true,
  agentVersionAvailable: true,
  voiceAvailable: true,
  previewKeyDomainRestricted: true,
  recaptchaProtection: 'enabled',
  recordingDisabled: true
};

function service(
  session: AppSession,
  options: {
    connection?: VoiceProviderConnectionResult;
    previewPassed?: boolean;
  } = {}
) {
  const tester = {
    test: vi.fn(() =>
      Promise.resolve(options.connection ?? healthyConnection)
    )
  };
  const previewSessions = {
    verify: vi.fn(() =>
      Promise.resolve({
        sessionId: 'preview-session-1',
        passed: options.previewPassed ?? true
      })
    )
  };
  return {
    tester,
    previewSessions,
    settings: createVoiceSettingsService({
      database: client.db,
      session,
      tester,
      previewSessions,
      clock: { now: () => now }
    })
  };
}

describe('voice settings service', () => {
  it('requires an Administrator and exact confirmation to enable automatic voice, and audits enable and disable', async () => {
    const seeded = await seed();
    const adminHarness = service(seeded.session('ADMIN'));
    await adminHarness.settings.save(saveInput(seeded.organisationId));
    await adminHarness.settings.testConnection({
      organisationId: seeded.organisationId
    });
    await adminHarness.settings.recordGenericFlowTest({
      organisationId: seeded.organisationId,
      previewSessionToken: 'signed-preview-token'
    });
    await adminHarness.settings.setEnabled({
      organisationId: seeded.organisationId,
      enabled: true,
      confirmation: 'ENABLE VOICE CALLS'
    });

    await expect(
      service(seeded.session('OPERATOR')).settings.setAutomaticVoiceCalls({
        organisationId: seeded.organisationId,
        enabled: true,
        confirmation: 'ENABLE AUTOMATIC VOICE CALLS'
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      adminHarness.settings.setAutomaticVoiceCalls({
        organisationId: seeded.organisationId,
        enabled: true,
        confirmation: 'enable it'
      })
    ).rejects.toThrow('VOICE_AUTOMATIC_ENABLE_CONFIRMATION_REQUIRED');

    await expect(
      adminHarness.settings.setAutomaticVoiceCalls({
        organisationId: seeded.organisationId,
        enabled: true,
        confirmation: 'ENABLE AUTOMATIC VOICE CALLS'
      })
    ).resolves.toMatchObject({ enabled: true, automaticEnabled: true });
    await expect(
      adminHarness.settings.setAutomaticVoiceCalls({
        organisationId: seeded.organisationId,
        enabled: false
      })
    ).resolves.toMatchObject({ enabled: true, automaticEnabled: false });

    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'VOICE_AUTOMATIC_CALLS_ENABLED',
        'VOICE_AUTOMATIC_CALLS_DISABLED'
      ])
    );
    const automaticEvents = events.filter((event) =>
      event.eventType.startsWith('VOICE_AUTOMATIC_CALLS_')
    );
    expect(automaticEvents).toHaveLength(2);
    expect(automaticEvents.every((event) => event.actorUserId === seeded.userId)).toBe(
      true
    );

    const [organisation] = await client.db
      .select({
        sendMode: organisations.sendMode,
        rolloutScope: organisations.rolloutScope
      })
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toEqual({
      sendMode: 'live',
      rolloutScope: 'CUSTOMER'
    });
  });

  it('allows only Administrators to save safe settings and audits field names without credential values', async () => {
    const seeded = await seed();
    const input = saveInput(seeded.organisationId);

    await expect(
      service(seeded.session('OPERATOR')).settings.save(input)
    ).rejects.toThrow('FORBIDDEN');

    const admin = service(seeded.session('ADMIN')).settings;
    const view = await admin.save(input);

    await expect(
      service(seeded.session('OPERATOR')).settings.get(
        seeded.organisationId
      )
    ).rejects.toThrow('FORBIDDEN');

    expect(view).toMatchObject({
      configured: true,
      enabled: false,
      provider: 'RETELL',
      secretReferenceLabel: 'RETELL_API_KEY',
      previewPublicKey: 'public_key_accountpulse_preview',
      agentId: 'agent_accountpulse',
      agentVersion: 7,
      voiceId: 'voice_australian_1',
      connectionReady: false,
      genericFlowReady: false
    });
    expect(view).not.toHaveProperty('secretReference');

    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'VOICE_SETTINGS_CHANGED',
      entityType: 'ORGANISATION_VOICE_SETTINGS'
    });
    expect(events[0]?.afterValue?.changedFields).toEqual(
      expect.arrayContaining([
        'secretReference',
        'previewPublicKey',
        'agentId',
        'agentVersion',
        'outboundNumber'
      ])
    );
    expect(JSON.stringify(events)).not.toContain(input.secretReference);
    expect(JSON.stringify(events)).not.toContain(input.previewPublicKey);
  });

  it.each([
    ['raw Retell private key', { secretReference: 'key_private_secret_value' }],
    ['invalid outbound number', { outboundNumber: '02 5550 1234' }],
    ['invalid fallback number', { fallbackOfficeNumber: 'not-a-number' }],
    ['invalid SIP target', { transferSipUri: 'https://example.invalid' }],
    ['invalid timezone', { timezone: 'Australia/Atlantis' }],
    ['invalid calling window', { weekdayStartLocal: '17:00' }]
  ])('rejects %s', async (_label, patch) => {
    const seeded = await seed();
    const settings = service(seeded.session('ADMIN')).settings;

    await expect(
      settings.save({ ...saveInput(seeded.organisationId), ...patch })
    ).rejects.toThrow('VOICE_SETTINGS_INVALID');
  });

  it('requires current connection and fictional-flow evidence before enabling voice without changing Customer Live', async () => {
    const seeded = await seed();
    const harness = service(seeded.session('ADMIN'));
    await harness.settings.save(saveInput(seeded.organisationId));

    await expect(
      harness.settings.setEnabled({
        organisationId: seeded.organisationId,
        enabled: true,
        confirmation: 'ENABLE VOICE CALLS'
      })
    ).rejects.toThrow('VOICE_SETTINGS_NOT_READY');

    const connection = await harness.settings.testConnection({
      organisationId: seeded.organisationId
    });
    expect(connection).toEqual({ healthy: true, ...healthyConnection });
    expect(harness.tester.test).toHaveBeenCalledWith({
      organisationId: seeded.organisationId,
      provider: 'RETELL',
      secretReference: 'env:RETELL_API_KEY',
      previewPublicKey: 'public_key_accountpulse_preview',
      agentId: 'agent_accountpulse',
      agentVersion: 7,
      voiceId: 'voice_australian_1'
    });

    const preview = await harness.settings.recordGenericFlowTest({
      organisationId: seeded.organisationId,
      previewSessionToken: 'signed-preview-token'
    });
    expect(preview).toMatchObject({ passed: true, sessionId: 'preview-session-1' });
    expect(harness.previewSessions.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: seeded.organisationId,
        userId: seeded.userId,
        previewSessionToken: 'signed-preview-token',
        configurationVersion: 1,
        agentId: 'agent_accountpulse',
        agentVersion: 7,
        voiceId: 'voice_australian_1'
      })
    );

    await expect(
      harness.settings.setEnabled({
        organisationId: seeded.organisationId,
        enabled: true,
        confirmation: 'enable it'
      })
    ).rejects.toThrow('VOICE_ENABLE_CONFIRMATION_REQUIRED');

    const enabled = await harness.settings.setEnabled({
      organisationId: seeded.organisationId,
      enabled: true,
      confirmation: 'ENABLE VOICE CALLS'
    });
    expect(enabled).toMatchObject({
      enabled: true,
      connectionReady: true,
      genericFlowReady: true
    });

    const [organisation] = await client.db
      .select({
        sendMode: organisations.sendMode,
        rolloutScope: organisations.rolloutScope
      })
      .from(organisations)
      .where(eq(organisations.id, seeded.organisationId));
    expect(organisation).toEqual({
      sendMode: 'live',
      rolloutScope: 'CUSTOMER'
    });
  });

  it('marks evidence stale and disables voice when the pinned agent changes', async () => {
    const seeded = await seed();
    const harness = service(seeded.session('ADMIN'));
    const input = saveInput(seeded.organisationId);
    await harness.settings.save(input);
    await harness.settings.testConnection({
      organisationId: seeded.organisationId
    });
    await harness.settings.recordGenericFlowTest({
      organisationId: seeded.organisationId,
      previewSessionToken: 'signed-preview-token'
    });
    await harness.settings.setEnabled({
      organisationId: seeded.organisationId,
      enabled: true,
      confirmation: 'ENABLE VOICE CALLS'
    });

    const changed = await harness.settings.save({
      ...input,
      agentVersion: input.agentVersion + 1
    });
    expect(changed).toMatchObject({
      enabled: false,
      connectionReady: false,
      genericFlowReady: false
    });
    await expect(
      harness.settings.setEnabled({
        organisationId: seeded.organisationId,
        enabled: true,
        confirmation: 'ENABLE VOICE CALLS'
      })
    ).rejects.toThrow('VOICE_SETTINGS_NOT_READY');

    await harness.settings.save(input);
    await harness.settings.testConnection({
      organisationId: seeded.organisationId
    });
    await expect(
      harness.settings.get(seeded.organisationId)
    ).resolves.toMatchObject({
      enabled: false,
      connectionReady: true,
      genericFlowReady: false
    });
  });

  it('does not record an unverified or failed browser setup preview', async () => {
    const seeded = await seed();
    const harness = service(seeded.session('ADMIN'), {
      previewPassed: false
    });
    await harness.settings.save(saveInput(seeded.organisationId));

    await expect(
      harness.settings.recordGenericFlowTest({
        organisationId: seeded.organisationId,
        previewSessionToken: 'invalid-or-failed-preview'
      })
    ).rejects.toThrow('VOICE_PREVIEW_NOT_VERIFIED');

    const [stored] = await client.db
      .select()
      .from(organisationVoiceSettings)
      .where(
        eq(
          organisationVoiceSettings.organisationId,
          seeded.organisationId
        )
      );
    expect(stored?.enabled).toBe(false);
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(events.map((event) => event.eventType)).not.toContain(
      'VOICE_GENERIC_FLOW_TESTED'
    );
  });
});
