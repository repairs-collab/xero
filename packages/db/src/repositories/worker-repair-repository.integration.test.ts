import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import { platformAdminAuditEvents, users, workerRepairRequests, workerRepairRunner } from '../schema/index.js';
import {
  loadLatestWorkerRepair,
  loadWorkerRepairRunnerAvailable,
  requestWorkerRepair
} from './worker-repair-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const owner = randomUUID();
const anotherOwner = randomUUID();
const disabledOwner = randomUUID();
const operator = randomUUID();

beforeAll(async () => {
  await migrateDatabase(client.db);
  const testUsers = [owner, anotherOwner, disabledOwner, operator]
    .map<typeof users.$inferInsert>((id) => ({
      id,
      email: `${id}@example.invalid`,
      cognitoSubject: id,
      displayName: 'Worker repair test user',
      platformRole: id === operator ? null : 'OWNER',
      disabledAt: id === disabledOwner ? new Date() : null
    }));
  await client.db.insert(users).values(testUsers);
});

afterAll(async () => {
  await client.pool.end();
});

beforeEach(async () => {
  await client.db.delete(workerRepairRequests)
    .where(inArray(workerRepairRequests.requestedByUserId, [owner, anotherOwner]));
  await client.db.insert(workerRepairRunner).values({ id: 1, lastSeenAt: sql`now()` })
    .onConflictDoUpdate({ target: workerRepairRunner.id, set: { lastSeenAt: sql`now()` } });
});

describe('owner worker repair requests', () => {
  it('requires an active platform owner and a live host runner', async () => {
    expect(await requestWorkerRepair(client.db, operator, randomUUID())).toBe('NOT_OWNER');
    expect(await requestWorkerRepair(client.db, disabledOwner, randomUUID())).toBe('NOT_OWNER');
    expect(await requestWorkerRepair(client.db, owner, 'command or invalid token')).toBe('INVALID_REQUEST');
    await client.db.update(workerRepairRunner).set({ lastSeenAt: sql`now() - interval '3 minutes'` });
    expect(await loadWorkerRepairRunnerAvailable(client.db)).toBe(false);
    expect(await requestWorkerRepair(client.db, owner, randomUUID())).toBe('RUNNER_UNAVAILABLE');
    expect(await loadLatestWorkerRepair(client.db)).toBeNull();
  });

  it('deduplicates concurrent owner submissions, audits the request and enforces the cooldown', async () => {
    expect(await loadWorkerRepairRunnerAvailable(client.db)).toBe(true);
    const requestIds = [randomUUID(), randomUUID()];
    const results = await Promise.all([
      requestWorkerRepair(client.db, owner, requestIds[0]!),
      requestWorkerRepair(client.db, anotherOwner, requestIds[1]!)
    ]);
    expect(results.toSorted()).toEqual(['ALREADY_REQUESTED', 'REQUESTED']);
    const requestId = requestIds[results.indexOf('REQUESTED')]!;
    const requests = await client.db.select().from(workerRepairRequests);
    expect(requests.map(({ id }) => id)).toEqual([requestId]);
    const audit = await client.db.select().from(platformAdminAuditEvents)
      .where(eq(platformAdminAuditEvents.entityId, requestId));
    expect(audit.map(({ eventType }) => eventType)).toEqual(['WORKER_REPAIR_REQUESTED']);
    expect(await loadLatestWorkerRepair(client.db)).toMatchObject({ status: 'PENDING', resultCode: null });

    await client.db.update(workerRepairRequests)
      .set({
        status: 'FAILED', resultCode: 'CORRECTED_RELEASE_REQUIRED',
        claimedAt: sql`now()`, claimExpiresAt: sql`now() + interval '2 minutes'`, completedAt: sql`now()`,
        beforeHealth: 'UNHEALTHY', afterHealth: 'DOWN'
      })
      .where(eq(workerRepairRequests.id, requestId));
    expect(await loadLatestWorkerRepair(client.db))
      .toMatchObject({ status: 'FAILED', resultCode: 'CORRECTED_RELEASE_REQUIRED', afterHealth: 'DOWN' });
    expect(await requestWorkerRepair(client.db, owner, randomUUID())).toBe('COOLDOWN');
    await client.db.update(workerRepairRunner).set({ lastSeenAt: sql`now() - interval '3 minutes'` });
    expect(await requestWorkerRepair(client.db, owner, requestId)).toBe('ALREADY_REQUESTED');
  });

  it('reports an abandoned request as expired without asking an unhealthy host to retry it', async () => {
    await client.db.insert(workerRepairRequests).values({
      id: randomUUID(),
      requestedByUserId: owner,
      requestedAt: sql`now() - interval '6 minutes'`,
      expiresAt: sql`now() - interval '1 minute'`
    });
    expect(await loadLatestWorkerRepair(client.db))
      .toMatchObject({ status: 'EXPIRED', resultCode: 'EXPIRED_BEFORE_START' });
  });

  it('blocks an old calculation without materialized stages and an execute job due during restart', async () => {
    const runner = readFileSync(new URL('../../../../deploy/ovh/run-worker-repair.sh', import.meta.url), 'utf8')
      .replaceAll('\r\n', '\n');
    const preflight = /preflight\(\) \{[^\n]*\n[^\n]*<<'SQL'\nBEGIN;\n([\s\S]+?)\nCOMMIT;\nSQL/.exec(runner)?.[1];
    if (!preflight) throw new Error('Protected runner safety statement could not be read');
    const check = preflight.replace(/(?:public|pgboss)\./g, 'pg_temp.').replaceAll(":'request_id'", '$1');
    const isolated = await client.pool.connect();
    const requestId = randomUUID();
    try {
      await isolated.query('BEGIN');
      for (const table of [
        'users', 'worker_repair_requests', 'platform_admin_audit_events',
        'stage_instances', 'organisations', 'invoice_chases', 'reminder_sequences',
        'reminder_sequence_versions', 'voice_call_requests'
      ]) {
        await isolated.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
      }
      await isolated.query(`
        CREATE TEMP TABLE job (name text, state text, start_after timestamptz, created_on timestamptz) ON COMMIT DROP
      `);
      await isolated.query(`
        INSERT INTO pg_temp.users (id, cognito_subject, email, display_name, platform_role)
        VALUES ($1, 'isolated', 'isolated@example.invalid', 'Owner', 'OWNER')
      `, [owner]);
      await isolated.query(`
        INSERT INTO pg_temp.worker_repair_requests (id, requested_by_user_id, status, claimed_at, claim_expires_at)
        VALUES ($1, $2, 'RUNNING', now(), now() + interval '2 minutes')
      `, [requestId, owner]);
      expect((await isolated.query(check, [requestId])).rows).toEqual([{ result: 'CLEAR' }]);

      await isolated.query(`
        INSERT INTO pg_temp.job VALUES
          ('reminders.calculate', 'created', now() - interval '20 minutes', now() - interval '20 minutes')
      `);
      expect((await isolated.query(check, [requestId])).rows)
        .toEqual([{ result: 'SEND_BACKLOG_REVIEW_REQUIRED' }]);
      await isolated.query("UPDATE pg_temp.job SET state = 'completed'");
      await isolated.query(`
        INSERT INTO pg_temp.job VALUES ('reminder.execute', 'created', now() + interval '90 seconds', now())
      `);
      expect((await isolated.query(check, [requestId])).rows)
        .toEqual([{ result: 'SEND_BACKLOG_REVIEW_REQUIRED' }]);
      expect((await isolated.query('SELECT event_type FROM pg_temp.platform_admin_audit_events')).rows)
        .toEqual([{ event_type: 'WORKER_REPAIR_RESTART_ATTEMPTED' }]);
    } finally {
      await isolated.query('ROLLBACK');
      isolated.release();
    }
  });
});
