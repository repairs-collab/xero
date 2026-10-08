import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  approvals,
  auditEvents,
  contactChannels,
  contacts,
  invoiceChases,
  invoices,
  organisationVoiceSettings,
  organisations,
  outboundMessages,
  reminderSequenceVersions,
  reminderSequences,
  stageInstances,
  suppressions,
  tasks,
  voiceCallEvents,
  voiceGatewaySessions,
  voiceCallInvoices,
  voiceCallRequests,
  webhookEvents,
  users
} from './index.js';
import * as schema from './index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const database = createDatabase(databaseUrl);

const tableColumns = async (tableName: string): Promise<string[]> => {
  const result = await database.pool.query<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
};

const tableExists = async (tableName: string): Promise<boolean> => {
  const result = await database.pool.query<{ exists: boolean }>(
    `select exists (
       select 1
         from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
     ) as exists`,
    [tableName]
  );
  return result.rows[0]?.exists === true;
};

beforeAll(async () => {
  await migrateDatabase(database.db);
});

afterAll(async () => {
  await database.pool.end();
});

const seedStageInstance = async () => {
  const organisationId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const chaseId = randomUUID();
  const stageInstanceId = randomUUID();

  await database.db.insert(organisations).values({
    id: organisationId,
    name: 'Test Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await database.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Test Customer',
    active: true
  });
  await database.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '100.0000',
    currency: 'AUD',
    syncVersion: 1
  });
  await database.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: 'Starter sequence',
    mode: 'REVIEW'
  });
  await database.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {}
  });
  await database.db.insert(invoiceChases).values({
    id: chaseId,
    organisationId,
    invoiceId,
    sequenceId,
    status: 'ACTIVE'
  });
  await database.db.insert(stageInstances).values({
    id: stageInstanceId,
    organisationId,
    invoiceChaseId: chaseId,
    sequenceVersionId,
    stageKey: 'due-date',
    channel: 'SMS',
    status: 'DUE',
    scheduledAt: new Date('2026-09-18T00:00:00Z'),
    sourceVersion: 1
  });

  return { organisationId, contactId, invoiceId, stageInstanceId };
};

const seedUser = async (label: string): Promise<string> => {
  const id = randomUUID();
  await database.db.insert(users).values({
    id,
    cognitoSubject: randomUUID(),
    email: id + '@example.invalid',
    displayName: label
  });
  return id;
};

const seedVoiceCall = async (
  input: {
    organisationId: string;
    contactId: string;
    actorUserId: string;
    idempotencyKey?: string;
    providerCallId?: string;
    state?: 'DRAFT' | 'APPROVED';
    callFlowVersion?: number | null;
    callFlowHash?: string | null;
    approvedFactsHash?: string | null;
    approvedAt?: Date | null;
    purpose?: 'CUSTOMER' | 'TEST';
    provider?: 'RETELL' | 'VOIPCLOUD';
  }
): Promise<string> => {
  const id = randomUUID();
  const approved = input.state === 'APPROVED';
  await database.db.insert(voiceCallRequests).values({
    id,
    organisationId: input.organisationId,
    contactId: input.contactId,
    actorUserId: input.actorUserId,
    provider: input.provider ?? 'VOIPCLOUD',
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    accountName: 'Test Customer',
    destinationNumber: '+61400000000',
    outboundNumber: '+61255501234',
    combinedAmount: '100.0000',
    currency: 'AUD',
    callFlowVersion:
      input.callFlowVersion === undefined
        ? approved ? 1 : null
        : input.callFlowVersion,
    callFlowHash:
      input.callFlowHash === undefined
        ? approved ? 'sha256:flow-v1' : null
        : input.callFlowHash,
    approvedFactsHash:
      input.approvedFactsHash === undefined
        ? approved ? 'sha256:facts' : null
        : input.approvedFactsHash,
    agentId: 'agent_accountpulse',
    agentVersion: 1,
    voiceId: 'voice_au',
    voipcloudUserNumber: '1099',
    ttsVoiceId: 'en_GB-alba-medium',
    gatewayFlowVersion: 1,
    voiceSettingsUpdatedAt: new Date('2026-10-07T00:00:00.000Z'),
    transferTargetLabel: 'Main office',
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    state: input.state ?? 'DRAFT',
    providerCallId: input.providerCallId,
    approvedAt: input.approvedAt
  });
  return id;
};

describe('database invariants', () => {
  it('defaults voice calls to CUSTOMER and accepts the isolated TEST purpose', async () => {
    const { organisationId, contactId } = await seedStageInstance();
    const actorUserId = await seedUser('Voice purpose operator');
    const customerCallId = await seedVoiceCall({
      organisationId,
      contactId,
      actorUserId
    });
    const testCallId = await seedVoiceCall({
      organisationId,
      contactId,
      actorUserId,
      purpose: 'TEST'
    });

    const rows = await database.db
      .select({ id: voiceCallRequests.id, purpose: voiceCallRequests.purpose })
      .from(voiceCallRequests)
      .where(inArray(voiceCallRequests.id, [customerCallId, testCallId]));
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: customerCallId, purpose: 'CUSTOMER' },
        { id: testCallId, purpose: 'TEST' }
      ])
    );
  });

  it('prevents two outbound rows with the same organisation idempotency key', async () => {
    const { organisationId, stageInstanceId } = await seedStageInstance();
    const idempotencyKey = `${organisationId}:due-date:sms:+61400000000:v1`;
    const value = {
      organisationId,
      stageInstanceId,
      channel: 'SMS' as const,
      recipientKey: '+61400000000',
      sourceVersion: 1,
      contentHash: 'sha256:test',
      status: 'PENDING' as const,
      idempotencyKey
    };

    await database.db.insert(outboundMessages).values(value);
    await expect(
      database.db.insert(outboundMessages).values(value)
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('requires organisation ownership on customer records', async () => {
    await expect(
      database.pool.query(
        'insert into contacts (id, organisation_id, xero_contact_id, name, active) values ($1, $2, $3, $4, $5)',
        [randomUUID(), null, randomUUID(), 'No owner', true]
      )
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('exports the reminder whitelist schema', () => {
    expect(schema).toHaveProperty('reminderWhitelistEntries');
  });

  it('exports reset manifests and rollout reconciliations', () => {
    expect(schema).toHaveProperty('operationalResetRuns');
    expect(schema).toHaveProperty('rolloutReconciliations');
  });

  it('keeps one voice settings row per organisation without secret material columns', async () => {
    const { organisationId } = await seedStageInstance();
    const userId = await seedUser('Voice settings administrator');
    const values = {
      organisationId,
      enabled: false,
      provider: 'VOIPCLOUD' as const,
      secretReference: 'VOIPCLOUD_API_KEY',
      previewPublicKey: 'public_key_accountpulse',
      agentId: 'agent_accountpulse',
      agentVersion: 1,
      voiceId: 'voice_au',
      voiceLabel: 'Australian English',
      voipcloudUserNumber: '1099',
      ttsVoiceId: 'en_GB-alba-medium',
      gatewayFlowVersion: 1,
      outboundNumber: '+61255501234',
      fallbackOfficeNumber: '+61255504321',
      officeDestinationLabel: 'Main office',
      timezone: 'Australia/Sydney',
      weekdayStartLocal: '09:00',
      weekdayEndLocal: '17:00',
      updatedByUserId: userId
    };

    await database.db.insert(organisationVoiceSettings).values(values);
    await expect(
      database.db.insert(organisationVoiceSettings).values(values)
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    const columns = await tableColumns('organisation_voice_settings');
    expect(columns).toContain('preview_public_key');
    expect(columns).toContain('secret_reference');
    expect(columns).toEqual(
      expect.arrayContaining([
        'voipcloud_user_number',
        'tts_voice_id',
        'gateway_flow_version',
        'last_gateway_tested_at',
        'last_gateway_test_succeeded',
        'last_controlled_flow_tested_at'
      ])
    );
    expect(columns).not.toContain('secret_arn');
    expect(columns).not.toContain('voicemail_template');
    expect(columns).not.toContain('api_key');
    expect(columns).not.toContain('sip_password');
  });

  it('enforces organisation idempotency and provider call uniqueness for voice requests', async () => {
    const { organisationId, contactId } = await seedStageInstance();
    const actorUserId = await seedUser('Voice operator');
    const idempotencyKey = 'voice-call-idempotency';
    await seedVoiceCall({
      organisationId,
      contactId,
      actorUserId,
      idempotencyKey,
      providerCallId: 'voipcloud-call-1'
    });

    await expect(
      seedVoiceCall({
        organisationId,
        contactId,
        actorUserId,
        idempotencyKey
      })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      seedVoiceCall({
        organisationId,
        contactId,
        actorUserId,
        providerCallId: 'voipcloud-call-1'
      })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('keeps one immutable invoice snapshot per voice call and invoice', async () => {
    const { organisationId, contactId, invoiceId } =
      await seedStageInstance();
    const actorUserId = await seedUser('Voice snapshot operator');
    const voiceCallId = await seedVoiceCall({
      organisationId,
      contactId,
      actorUserId
    });
    const snapshot = {
      voiceCallId,
      organisationId,
      invoiceId,
      xeroInvoiceId: 'xero-invoice-snapshot',
      invoiceNumber: 'INV-SNAPSHOT',
      amountDue: '100.0000',
      currency: 'AUD',
      dueDate: '2026-08-31',
      syncVersion: 1,
      snapshotAt: new Date('2026-10-07T00:00:00.000Z')
    };

    await database.db.insert(voiceCallInvoices).values(snapshot);
    await expect(
      database.db.insert(voiceCallInvoices).values(snapshot)
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('deduplicates normalised VoIPcloud events by organisation and provider key', async () => {
    const { organisationId, contactId } = await seedStageInstance();
    const actorUserId = await seedUser('Voice event operator');
    const voiceCallId = await seedVoiceCall({
      organisationId,
      contactId,
      actorUserId
    });
    const event = {
      organisationId,
      voiceCallId,
      provider: 'VOIPCLOUD' as const,
      providerEventKey: 'call-1:call_started:1',
      eventType: 'CALL_STARTED',
      safeState: 'IN_PROGRESS' as const,
      occurredAt: new Date('2026-10-07T00:01:00.000Z')
    };

    await database.db.insert(voiceCallEvents).values(event);
    await expect(
      database.db.insert(voiceCallEvents).values(event)
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('keeps gateway coordination unique, tenant-bound, and free of billing facts', async () => {
    const owner = await seedStageInstance();
    const ownerUserId = await seedUser('Gateway session owner');
    const firstCallId = await seedVoiceCall({
      organisationId: owner.organisationId,
      contactId: owner.contactId,
      actorUserId: ownerUserId
    });
    const secondCallId = await seedVoiceCall({
      organisationId: owner.organisationId,
      contactId: owner.contactId,
      actorUserId: ownerUserId
    });
    const firstSession = {
      organisationId: owner.organisationId,
      voiceCallId: firstCallId,
      providerUserNumber: '1099',
      idempotencyKey: 'gateway-session-one',
      commandHash: 'sha256:gateway-command-one'
    };

    await database.db.insert(voiceGatewaySessions).values(firstSession);
    await expect(
      database.db.insert(voiceGatewaySessions).values({
        ...firstSession,
        providerUserNumber: '1100',
        idempotencyKey: 'gateway-session-duplicate-call'
      })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      database.db.insert(voiceGatewaySessions).values({
        ...firstSession,
        voiceCallId: secondCallId,
        providerUserNumber: '1100'
      })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      database.db.insert(voiceGatewaySessions).values({
        ...firstSession,
        voiceCallId: secondCallId,
        idempotencyKey: 'gateway-session-two'
      })
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    await database.db
      .update(voiceGatewaySessions)
      .set({ state: 'COMPLETED' })
      .where(eq(voiceGatewaySessions.voiceCallId, firstCallId));
    await expect(
      database.db.insert(voiceGatewaySessions).values({
        ...firstSession,
        voiceCallId: secondCallId,
        idempotencyKey: 'gateway-session-two',
        commandHash: 'sha256:gateway-command-two'
      })
    ).resolves.toBeDefined();

    const outsider = await seedStageInstance();
    await expect(
      database.db.insert(voiceGatewaySessions).values({
        organisationId: outsider.organisationId,
        voiceCallId: firstCallId,
        providerUserNumber: '1200',
        idempotencyKey: 'gateway-session-cross-tenant',
        commandHash: 'sha256:gateway-command-cross-tenant'
      })
    ).rejects.toMatchObject({ cause: { code: '23503' } });

    const columns = await tableColumns('voice_gateway_sessions');
    expect(columns).toEqual(
      expect.arrayContaining([
        'gateway_call_id',
        'organisation_id',
        'voice_call_id',
        'provider_user_number',
        'idempotency_key',
        'command_hash',
        'state',
        'last_event_sequence',
        'safe_failure_code'
      ])
    );
    expect(columns).not.toEqual(
      expect.arrayContaining([
        'invoice_number',
        'amount_due',
        'destination_number',
        'approved_facts',
        'script',
        'audio'
      ])
    );
  });

  it('preserves legacy Retell voice rows for audit reads', async () => {
    const { organisationId, contactId } = await seedStageInstance();
    const actorUserId = await seedUser('Legacy Retell audit operator');
    const voiceCallId = await seedVoiceCall({
      organisationId,
      contactId,
      actorUserId,
      provider: 'RETELL'
    });

    const [row] = await database.db
      .select({ provider: voiceCallRequests.provider })
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, voiceCallId));
    expect(row).toEqual({ provider: 'RETELL' });
  });

  it('allows direct approval with pinned flow and fact hashes', async () => {
    const { organisationId, contactId } = await seedStageInstance();
    const actorUserId = await seedUser('Voice approval operator');

    await expect(
      seedVoiceCall({
        organisationId,
        contactId,
        actorUserId,
        state: 'APPROVED',
        callFlowVersion: 1,
        callFlowHash: 'sha256:flow-v1',
        approvedFactsHash: 'sha256:facts',
        approvedAt: new Date('2026-10-08T00:00:00.000Z')
      })
    ).resolves.toBeTypeOf('string');
  });

  it('requires pinned flow and fact hashes before a voice request can be approved', async () => {
    const { organisationId, contactId } = await seedStageInstance();
    const actorUserId = await seedUser('Voice approval guard operator');

    await expect(
      seedVoiceCall({
        organisationId,
        contactId,
        actorUserId,
        state: 'APPROVED',
        callFlowVersion: null,
        callFlowHash: null,
        approvedFactsHash: null,
        approvedAt: null
      })
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('round-trips VOICE channels, legacy and current voice providers, and voice review task kinds', async () => {
    const { organisationId, contactId } = await seedStageInstance();
    const userId = await seedUser('Voice review administrator');
    await database.db.insert(contactChannels).values({
      organisationId,
      contactId,
      kind: 'VOICE',
      sourceValue: '0400 000 000',
      normalisedValue: '+61400000000'
    });
    await database.db.insert(suppressions).values({
      organisationId,
      channel: 'VOICE',
      normalisedDestination: '+61400000000',
      source: 'WRONG_PERSON',
      reason: 'Wrong person reported',
      consentState: 'SUPPRESSED',
      recordedByUserId: userId
    });
    await database.db.insert(webhookEvents).values({
      organisationId,
      provider: 'VOIPCLOUD',
      providerEventKey: randomUUID(),
      bodyHash: 'sha256:retell',
      signatureValid: true,
      providerPayload: {}
    });
    await database.db.insert(tasks).values([
      {
        organisationId,
        contactId,
        kind: 'VOICE_CONTACT_REVIEW',
        summary: 'Verify the customer telephone number'
      },
      {
        organisationId,
        contactId,
        kind: 'VOICE_OUTCOME_REVIEW',
        summary: 'Reconcile the voice call outcome'
      }
    ]);

    const channel = await database.pool.query<{ kind: string }>(
      'select kind from contact_channels where organisation_id = $1 and contact_id = $2',
      [organisationId, contactId]
    );
    const taskKinds = await database.pool.query<{ kind: string }>(
      'select kind from tasks where organisation_id = $1 order by kind',
      [organisationId]
    );
    expect(channel.rows.map((row) => row.kind)).toContain('VOICE');
    expect(taskKinds.rows.map((row) => row.kind)).toEqual([
      'VOICE_CONTACT_REVIEW',
      'VOICE_OUTCOME_REVIEW'
    ]);
  });

  it('disables legacy voice configuration without changing Customer Live messaging', async () => {
    const client = await database.pool.connect();
    const organisationId = randomUUID();

    try {
      await client.query('begin');
      await client.query(
        `insert into organisations
          (id, xero_organisation_id, name, time_zone, base_currency,
           send_mode, rollout_scope, live_send_acknowledged)
         values ($1, $2, 'Voice migration safety', 'Australia/Sydney', 'AUD',
                 'live', 'CUSTOMER', true)`,
        [organisationId, randomUUID()]
      );
      await client.query(
        `insert into organisation_voice_settings
          (organisation_id, enabled, provider, secret_reference,
           preview_public_key, agent_id, agent_version, voice_id, voice_label,
           outbound_number, fallback_office_number, office_destination_label,
           timezone, weekday_start_local, weekday_end_local,
           last_connection_tested_at, last_connection_test_succeeded)
         values ($1, true, 'RETELL', 'env:RETELL_API_KEY', 'legacy-public-key',
                 'legacy-agent', 1, 'legacy-voice', 'Australian English',
                 '+61255501234', '+61350324518', 'Main office',
                 'Australia/Sydney', '09:00', '17:00', now(), true)`,
        [organisationId]
      );
      const migration = await readFile(
        new URL(
          '../../drizzle/0010_direct_voipcloud_voice.sql',
          import.meta.url
        ),
        'utf8'
      );
      const reset = migration
        .split('-- direct-voipcloud-settings-reset:start')[1]
        ?.split('-- direct-voipcloud-settings-reset:end')[0]
        ?.trim();
      expect(reset).toBeDefined();
      await client.query(reset ?? 'select 1');

      const settings = await client.query<{
        enabled: boolean;
        provider: string;
        secret_reference: string | null;
        agent_id: string | null;
        last_connection_test_succeeded: boolean;
        last_gateway_test_succeeded: boolean;
        configuration_version: number;
      }>(
        `select enabled, provider, secret_reference, agent_id,
                last_connection_test_succeeded, last_gateway_test_succeeded,
                configuration_version
           from organisation_voice_settings
          where organisation_id = $1`,
        [organisationId]
      );
      const organisation = await client.query<{
        send_mode: string;
        rollout_scope: string;
        live_send_acknowledged: boolean;
      }>(
        `select send_mode, rollout_scope, live_send_acknowledged
           from organisations
          where id = $1`,
        [organisationId]
      );

      expect(settings.rows[0]).toEqual({
        enabled: false,
        provider: 'VOIPCLOUD',
        secret_reference: null,
        agent_id: null,
        last_connection_test_succeeded: false,
        last_gateway_test_succeeded: false,
        configuration_version: 1
      });
      expect(organisation.rows[0]).toEqual({
        send_mode: 'live',
        rollout_scope: 'CUSTOMER',
        live_send_acknowledged: true
      });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('keeps an existing live organisation controlled after rollout migration', async () => {
    const requiredColumns = [
      'rollout_scope',
      'maintenance_mode',
      'operational_state',
      'operational_state_version',
      'latest_reconciled_sync_at'
    ];
    const columns = await tableColumns('organisations');
    expect(columns).toEqual(expect.arrayContaining(requiredColumns));
    if (!requiredColumns.every((column) => columns.includes(column))) return;

    const organisationId = randomUUID();
    await database.db.insert(organisations).values({
      id: organisationId,
      name: 'Controlled live migration test',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      sendMode: 'live',
      liveSendAcknowledged: true
    });
    const result = await database.pool.query<{
      send_mode: string;
      rollout_scope: string;
      maintenance_mode: boolean;
      operational_state: string;
      operational_state_version: number;
      latest_reconciled_sync_at: Date | null;
    }>(
      `select send_mode, rollout_scope, maintenance_mode, operational_state,
              operational_state_version, latest_reconciled_sync_at
         from organisations
        where id = $1`,
      [organisationId]
    );

    expect(result.rows[0]).toEqual({
      send_mode: 'live',
      rollout_scope: 'CONTROLLED',
      maintenance_mode: false,
      operational_state: 'READY',
      operational_state_version: 0,
      latest_reconciled_sync_at: null
    });
  });

  it('rejects unsupported rollout and operational states', async () => {
    const columns = await tableColumns('organisations');
    expect(columns).toContain('rollout_scope');
    expect(columns).toContain('operational_state');
    if (
      !columns.includes('rollout_scope') ||
      !columns.includes('operational_state')
    ) {
      return;
    }

    const organisationId = randomUUID();
    await database.db.insert(organisations).values({
      id: organisationId,
      name: 'Invalid rollout state test',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await expect(
      database.pool.query(
        'update organisations set rollout_scope = $1 where id = $2',
        ['UNSAFE', organisationId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.pool.query(
        'update organisations set operational_state = $1 where id = $2',
        ['UNKNOWN', organisationId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows only one active operational reset per organisation', async () => {
    const exists = await tableExists('operational_reset_runs');
    expect(exists).toBe(true);
    if (!exists) return;

    const organisationId = randomUUID();
    const userId = randomUUID();
    await database.db.insert(organisations).values({
      id: organisationId,
      name: 'Reset uniqueness test',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await database.db.insert(users).values({
      id: userId,
      cognitoSubject: randomUUID(),
      email: `${userId}@example.invalid`,
      displayName: 'Reset administrator'
    });
    const insertReset = (id: string, status: string) =>
      database.pool.query(
        `insert into operational_reset_runs
          (id, organisation_id, status, requested_by_user_id, deployed_commit)
         values ($1, $2, $3, $4, $5)`,
        [id, organisationId, status, userId, '0123456789abcdef']
      );
    const firstId = randomUUID();
    await insertReset(firstId, 'PREPARING');
    await expect(
      insertReset(randomUUID(), 'RESETTING')
    ).rejects.toMatchObject({ code: '23505' });
    await database.pool.query(
      `update operational_reset_runs
          set status = 'COMPLETED', completed_at = now()
        where id = $1`,
      [firstId]
    );
    await expect(insertReset(randomUUID(), 'PREPARING')).resolves.toMatchObject(
      { rowCount: 1 }
    );
  });

  it('ties one reconciliation record to one organisation sync', async () => {
    const exists = await tableExists('rollout_reconciliations');
    expect(exists).toBe(true);
    if (!exists) return;

    const organisationId = randomUUID();
    const userId = randomUUID();
    const syncCompletedAt = new Date('2026-09-29T01:00:00.000Z');
    await database.db.insert(organisations).values({
      id: organisationId,
      name: 'Reconciliation uniqueness test',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await database.db.insert(users).values({
      id: userId,
      cognitoSubject: randomUUID(),
      email: `${userId}@example.invalid`,
      displayName: 'Reconciliation administrator'
    });
    const insertReconciliation = () =>
      database.pool.query(
        `insert into rollout_reconciliations
          (id, organisation_id, sync_completed_at, active_contact_count,
           outstanding_invoice_count, outstanding_totals,
           generated_approval_count, enabled_sequence_count,
           all_enabled_sequences_review, acknowledged_by_user_id,
           acknowledged_at)
         values ($1, $2, $3, 4, 5, $4, 6, 1, true, $5, $6)`,
        [
          randomUUID(),
          organisationId,
          syncCompletedAt,
          { AUD: '1234.5000' },
          userId,
          new Date('2026-09-29T01:05:00.000Z')
        ]
      );

    await insertReconciliation();
    await expect(insertReconciliation()).rejects.toMatchObject({
      code: '23505'
    });
    await expect(
      database.pool.query(
        `insert into rollout_reconciliations
          (id, organisation_id, sync_completed_at, active_contact_count,
           outstanding_invoice_count, outstanding_totals,
           generated_approval_count, enabled_sequence_count,
           all_enabled_sequences_review, acknowledged_by_user_id,
           acknowledged_at)
         values ($1, $2, $3, 0, 0, '{}'::jsonb, 0, 0, true, $4, $5)`,
        [
          randomUUID(),
          randomUUID(),
          syncCompletedAt,
          userId,
          new Date('2026-09-29T01:05:00.000Z')
        ]
      )
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps one active whitelist entry per target while retaining removed history', async () => {
    const { organisationId, contactId, invoiceId } = await seedStageInstance();
    const firstId = randomUUID();
    const insert = () =>
      database.pool.query(
        `insert into reminder_whitelist_entries
          (id, organisation_id, scope, contact_id, invoice_id, reason)
         values ($1, $2, 'INVOICE', $3, $4, 'Requested by customer')`,
        [randomUUID(), organisationId, contactId, invoiceId]
      );

    await database.pool.query(
      `insert into reminder_whitelist_entries
        (id, organisation_id, scope, contact_id, invoice_id, reason)
       values ($1, $2, 'INVOICE', $3, $4, 'Requested by customer')`,
      [firstId, organisationId, contactId, invoiceId]
    );
    await expect(insert()).rejects.toMatchObject({ code: '23505' });

    await database.pool.query(
      'update reminder_whitelist_entries set removed_at = now() where id = $1',
      [firstId]
    );
    await expect(insert()).resolves.toMatchObject({ rowCount: 1 });
    const history = await database.pool.query(
      'select id from reminder_whitelist_entries where organisation_id = $1 and invoice_id = $2',
      [organisationId, invoiceId]
    );
    expect(history.rowCount).toBe(2);
  });

  it('enforces client and invoice whitelist target shapes', async () => {
    const { organisationId, contactId, invoiceId } = await seedStageInstance();
    await expect(
      database.pool.query(
        `insert into reminder_whitelist_entries
          (id, organisation_id, scope, contact_id, invoice_id)
         values ($1, $2, 'CLIENT', $3, $4)`,
        [randomUUID(), organisationId, contactId, invoiceId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.pool.query(
        `insert into reminder_whitelist_entries
          (id, organisation_id, scope, contact_id)
         values ($1, $2, 'INVOICE', $3)`,
        [randomUUID(), organisationId, contactId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('preserves Outbox history when its reminder stage is removed', async () => {
    const { organisationId, contactId, invoiceId, stageInstanceId } =
      await seedStageInstance();
    const outboundId = randomUUID();
    await database.pool.query(
      `insert into outbound_messages
        (id, organisation_id, stage_instance_id, contact_id, invoice_id,
         channel, source, recipient_key, source_version, content,
         content_hash, status, idempotency_key)
       values ($1, $2, $3, $4, $5, 'SMS', 'AUTOMATED_REMINDER',
         '+61400000000', 1, 'Please pay', 'sha256:test', 'DELIVERED', $6)`,
      [
        outboundId,
        organisationId,
        stageInstanceId,
        contactId,
        invoiceId,
        `history:${outboundId}`
      ]
    );

    await database.db
      .delete(stageInstances)
      .where(eq(stageInstances.id, stageInstanceId));
    const history = await database.pool.query<{
      stage_instance_id: string | null;
    }>(
      'select stage_instance_id from outbound_messages where id = $1',
      [outboundId]
    );
    expect(history.rows[0]?.stage_instance_id).toBeNull();
  });

  it('backfills reliable historical Outbox associations and source classification', async () => {
    const { organisationId, contactId, invoiceId, stageInstanceId } =
      await seedStageInstance();
    const userId = randomUUID();
    const outboundId = randomUUID();
    await database.db.insert(users).values({
      id: userId,
      cognitoSubject: randomUUID(),
      email: `${userId}@example.invalid`,
      displayName: 'Historical operator'
    });
    await database.db
      .update(stageInstances)
      .set({ stageKey: 'manual', origin: 'AUTOMATION', createdByUserId: null })
      .where(eq(stageInstances.id, stageInstanceId));
    await database.db.insert(approvals).values({
      organisationId,
      stageInstanceId,
      renderedPreview: 'Historical approved reminder',
      sourceVersion: 1,
      status: 'APPROVED',
      decidedByUserId: userId,
      decidedAt: new Date('2026-09-18T00:01:00Z'),
      expiresAt: new Date('2026-09-19T00:00:00Z')
    });
    await database.db.insert(outboundMessages).values({
      id: outboundId,
      organisationId,
      stageInstanceId,
      channel: 'SMS',
      recipientKey: '+61400000000',
      sourceVersion: 1,
      status: 'DELIVERED',
      idempotencyKey: `historical:${outboundId}`
    });
    const migration = await readFile(
      new URL('../../drizzle/0005_accountpulse_operations.sql', import.meta.url),
      'utf8'
    );
    const backfill = migration
      .split('-- accountpulse-history-backfill:start')[1]
      ?.split('-- accountpulse-history-backfill:end')[0];
    expect(backfill).toBeDefined();
    for (const statement of (backfill ?? '')
      .split('--> statement-breakpoint')
      .map((value) => value.trim())
      .filter(Boolean)) {
      await database.pool.query(statement);
    }

    const [stage] = await database.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, stageInstanceId));
    const [outbound] = await database.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, outboundId));
    expect(stage).toMatchObject({
      origin: 'MANUAL_REMINDER',
      createdByUserId: userId
    });
    expect(outbound).toMatchObject({
      contactId,
      invoiceId,
      actorUserId: userId,
      source: 'MANUAL_REMINDER',
      content: 'Historical approved reminder'
    });
  });

  it('upgrades the originally applied voice schema forward without losing legacy references', async () => {
    const client = await database.pool.connect();
    const schemaName = `voice_upgrade_${randomUUID().replaceAll('-', '_')}`;
    const organisationId = randomUUID();
    const contactId = randomUUID();
    const invoiceId = randomUUID();
    const voiceCallId = randomUUID();

    try {
      await client.query('begin');
      await client.query(`create schema "${schemaName}"`);
      await client.query(`set local search_path to "${schemaName}"`);
      await client.query(`
        create table contacts (
          id uuid primary key,
          organisation_id uuid not null
        );
        create table invoices (
          id uuid primary key,
          organisation_id uuid not null
        );
        create table organisation_voice_settings (
          organisation_id uuid primary key,
          enabled boolean default false not null,
          provider varchar(16) default 'RETELL' not null,
          secret_arn text not null,
          preview_public_key text not null,
          agent_id text not null,
          agent_version integer not null,
          voice_id text not null,
          voice_label text not null,
          outbound_number text not null,
          transfer_sip_uri text,
          fallback_office_number text not null,
          office_destination_label text not null,
          timezone varchar(64) not null,
          weekday_start_local time(0) not null,
          weekday_end_local time(0) not null,
          voicemail_template text not null,
          last_connection_tested_at timestamptz,
          last_connection_test_succeeded boolean default false not null,
          updated_by_user_id uuid,
          created_at timestamptz default now() not null,
          updated_at timestamptz default now() not null
        );
        create table voice_call_requests (
          id uuid primary key,
          organisation_id uuid not null,
          contact_id uuid not null,
          actor_user_id uuid,
          provider varchar(16) default 'RETELL' not null,
          purpose varchar(16) default 'CUSTOMER' not null,
          destination_number text not null,
          outbound_number text not null,
          combined_amount numeric(19, 4) not null,
          currency char(3) not null,
          approved_script text,
          script_hash text,
          script_version integer,
          agent_id text not null,
          agent_version integer not null,
          voice_id text not null,
          voice_settings_updated_at timestamptz not null,
          transfer_target_label text not null,
          idempotency_key text not null,
          state varchar(24) default 'DRAFT' not null,
          outcome varchar(32),
          provider_call_id text,
          previewed_at timestamptz,
          approved_at timestamptz,
          queued_at timestamptz,
          provider_accepted_at timestamptz,
          answered_at timestamptz,
          completed_at timestamptz,
          failure_code text,
          failure_detail text,
          created_at timestamptz default now() not null,
          updated_at timestamptz default now() not null,
          constraint voice_call_requests_state_ck check (
            state in ('DRAFT', 'PREVIEWED', 'APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED', 'UNKNOWN')
          ),
          constraint voice_call_requests_approved_facts_ck check (
            state not in ('APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN')
            or (approved_script is not null and script_hash is not null and script_version is not null and previewed_at is not null and approved_at is not null)
          )
        );
        create table voice_call_invoices (
          voice_call_id uuid not null,
          organisation_id uuid not null,
          invoice_id uuid not null
        );
        create table voice_call_events (
          organisation_id uuid not null,
          voice_call_id uuid not null,
          provider varchar(16) default 'RETELL' not null,
          provider_event_key text not null,
          occurred_at timestamptz not null
        );
      `);
      await client.query(
        `insert into contacts (id, organisation_id) values ($1, $2)`,
        [contactId, organisationId]
      );
      await client.query(
        `insert into invoices (id, organisation_id) values ($1, $2)`,
        [invoiceId, organisationId]
      );
      await client.query(
        `insert into organisation_voice_settings (
          organisation_id, secret_arn, preview_public_key, agent_id,
          agent_version, voice_id, voice_label, outbound_number,
          fallback_office_number, office_destination_label, timezone,
          weekday_start_local, weekday_end_local, voicemail_template
        ) values ($1, $2, 'preview-key', 'agent', 1, 'voice', 'Australian',
                  '+61255501234', '+61350324518', 'Main office',
                  'Australia/Sydney', '09:00', '17:00', 'Legacy voicemail')`,
        [organisationId, 'env:RETELL_API_KEY']
      );
      await client.query(
        `insert into voice_call_requests (
          id, organisation_id, contact_id, destination_number,
          outbound_number, combined_amount, currency, approved_script,
          script_hash, script_version, agent_id, agent_version, voice_id,
          voice_settings_updated_at, transfer_target_label, idempotency_key,
          state, previewed_at, approved_at
        ) values ($1, $2, $3, '+61400000000', '+61255501234', 100, 'AUD',
                  'Legacy script', 'sha256:legacy-script', 1, 'agent', 1,
                  'voice', now(), 'Main office', 'legacy-call', 'COMPLETED',
                  now(), now())`,
        [voiceCallId, organisationId, contactId]
      );

      const migration = await readFile(
        new URL(
          '../../drizzle/0009_voice_schema_forward_repair.sql',
          import.meta.url
        ),
        'utf8'
      );
      for (const statement of migration
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean)) {
        await client.query(statement);
      }

      const settingsColumns = await client.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = $1 and table_name = 'organisation_voice_settings'`,
        [schemaName]
      );
      const requestColumns = await client.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = $1 and table_name = 'voice_call_requests'`,
        [schemaName]
      );
      const settings = await client.query<{
        configuration_version: number;
        secret_reference: string;
      }>('select configuration_version, secret_reference from organisation_voice_settings');
      const request = await client.query<{
        approved_facts_hash: string;
        call_flow_hash: string;
        call_flow_version: number;
      }>(
        'select approved_facts_hash, call_flow_hash, call_flow_version from voice_call_requests'
      );

      expect(settingsColumns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining(['configuration_version', 'secret_reference'])
      );
      expect(settingsColumns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining(['secret_arn', 'voicemail_template'])
      );
      expect(requestColumns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining([
          'call_flow_version',
          'call_flow_hash',
          'approved_facts_hash'
        ])
      );
      expect(requestColumns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining([
          'approved_script',
          'script_hash',
          'script_version',
          'previewed_at'
        ])
      );
      expect(settings.rows[0]).toEqual({
        configuration_version: 0,
        secret_reference: 'env:RETELL_API_KEY'
      });
      expect(request.rows[0]).toEqual({
        approved_facts_hash: `legacy-unverified:${voiceCallId}`,
        call_flow_hash: 'sha256:legacy-script',
        call_flow_version: 1
      });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it.each(['update', 'delete'] as const)(
    'prevents %s operations on append-only audit events',
    async (operation) => {
      const { organisationId } = await seedStageInstance();
      const inserted = await database.db
        .insert(auditEvents)
        .values({
          organisationId,
          eventType: 'TEST_EVENT',
          entityType: 'invoice',
          entityId: 'invoice-1',
          afterValue: { status: 'recorded' }
        })
        .returning({ id: auditEvents.id });
      const auditId = inserted[0]?.id;
      expect(auditId).toBeDefined();

      const query =
        operation === 'update'
          ? database.pool.query(
              'update audit_events set event_type = $1 where id = $2',
              ['CHANGED', auditId]
            )
          : database.pool.query('delete from audit_events where id = $1', [
              auditId
            ]);

      await expect(query).rejects.toThrow('audit_events is append-only');
    }
  );
});
