import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  approvals,
  auditEvents,
  contacts,
  invoiceChases,
  invoices,
  organisations,
  outboundMessages,
  reminderSequenceVersions,
  reminderSequences,
  stageInstances,
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

describe('database invariants', () => {
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
