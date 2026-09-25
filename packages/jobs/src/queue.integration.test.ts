import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { type Db, PgBoss } from 'pg-boss';

import { jobNames } from './names.js';
import { DurableJobQueue } from './queue.js';
import { ensureRecurringSchedules } from './schedules.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';

const queue = new DurableJobQueue({ databaseUrl });
const queueController = new PgBoss(databaseUrl);

beforeAll(async () => {
  await queue.start();
  await queueController.start();
});

afterAll(async () => {
  await queueController.stop({ graceful: false, timeout: 5_000 });
  await queue.stop();
});

describe('durable job queue', () => {
  it('deduplicates repeated enqueue attempts by singleton key', async () => {
    const organisationId = randomUUID();
    const singletonKey = `initial-sync:${organisationId}`;

    const firstId = await queue.enqueueUnique(
      jobNames.xeroInitialSync,
      { organisationId },
      singletonKey
    );
    const secondId = await queue.enqueueUnique(
      jobNames.xeroInitialSync,
      { organisationId },
      singletonKey
    );

    expect(secondId).toBe(firstId);
    const jobs = await queue.findJobs(jobNames.xeroInitialSync, {
      id: firstId
    });
    expect(jobs).toHaveLength(1);
  });

  it('rejects malformed payloads before writing a job', async () => {
    await expect(
      queue.enqueueUnique(
        jobNames.xeroInvoiceRefresh,
        { organisationId: '', invoiceId: '' },
        `bad:${randomUUID()}`
      )
    ).rejects.toThrow(/organisationId/i);
  });

  it('deduplicates an active Xero sync but allows a fresh sync after completion', async () => {
    const organisationId = randomUUID();
    const singletonKey = `${jobNames.xeroIncrementalSync}:${organisationId}`;

    const scheduledId = await queueController.send(
      jobNames.xeroIncrementalSync,
      { organisationId },
      { singletonKey, priority: 1_000_000 }
    );
    expect(scheduledId).not.toBeNull();
    if (scheduledId === null) throw new Error('Scheduled job was not created');
    const [active] = await queueController.fetch(
      jobNames.xeroIncrementalSync
    );
    expect(active?.id).toBe(scheduledId);

    const manualCollisionId = await queue.publish(
      jobNames.xeroIncrementalSync,
      { organisationId },
      { singletonKey, deduplicateWhileActive: true }
    );

    expect(manualCollisionId).toBe(scheduledId);
    const inFlight = await queue.findJobs(jobNames.xeroIncrementalSync, {
      key: singletonKey
    });
    expect(
      inFlight.filter((job) =>
        ['created', 'retry', 'active'].includes(job.state)
      )
    ).toHaveLength(1);

    await queueController.complete(
      jobNames.xeroIncrementalSync,
      scheduledId
    );
    const [completed] = await queue.findJobs(jobNames.xeroIncrementalSync, {
      id: scheduledId
    });
    expect(completed?.state).toBe('completed');

    const nextManualId = await queue.publish(
      jobNames.xeroIncrementalSync,
      { organisationId },
      { singletonKey, deduplicateWhileActive: true }
    );

    expect(nextManualId).not.toBe(scheduledId);
  });

  it('settles overlapping scheduled and manual sync inserts to one in-flight job', async () => {
    const organisationId = randomUUID();
    const singletonKey = `${jobNames.xeroIncrementalSync}:${organisationId}`;
    const scheduledClient = new Client({ connectionString: databaseUrl });
    const observer = new Client({ connectionString: databaseUrl });
    await scheduledClient.connect();
    await observer.connect();

    try {
      await scheduledClient.query('BEGIN');
      const scheduledDatabase: Db = {
        executeSql: async (text, values) => {
          const result = await scheduledClient.query(text, values);
          return { rows: result.rows };
        }
      };
      const scheduledId = await queueController.send(
        jobNames.xeroIncrementalSync,
        { organisationId },
        { singletonKey, db: scheduledDatabase }
      );
      expect(scheduledId).not.toBeNull();

      const manualPublish = queue.publish(
        jobNames.xeroIncrementalSync,
        { organisationId },
        { singletonKey, deduplicateWhileActive: true }
      );

      let manualIsWaiting = false;
      const deadline = Date.now() + 3_000;
      while (!manualIsWaiting && Date.now() < deadline) {
        const waiting = await observer.query(
          `SELECT 1
             FROM pg_stat_activity
            WHERE application_name = 'bill-chaser-active-singleton'
              AND wait_event_type = 'Lock'
            LIMIT 1`
        );
        manualIsWaiting = waiting.rowCount === 1;
        if (!manualIsWaiting) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(manualIsWaiting).toBe(true);

      const [manualResult, scheduledCommit] = await Promise.allSettled([
        manualPublish,
        scheduledClient.query('COMMIT')
      ]);
      if (scheduledCommit.status === 'rejected') {
        await scheduledClient.query('ROLLBACK');
      }

      expect(manualResult.status).toBe('fulfilled');
      const inFlight = (
        await queue.findJobs(jobNames.xeroIncrementalSync, {
          key: singletonKey
        })
      ).filter((job) => ['created', 'retry', 'active'].includes(job.state));
      expect(inFlight).toHaveLength(1);
      if (manualResult.status === 'fulfilled') {
        expect(manualResult.value).toBe(inFlight[0]?.id);
      }
    } finally {
      await scheduledClient.end();
      await observer.end();
    }
  });

  it('never automatically retries an external reminder send', async () => {
    const organisationId = randomUUID();
    const id = await queue.enqueueUnique(
      jobNames.reminderExecute,
      { organisationId, stageInstanceId: randomUUID() },
      `reminder:${randomUUID()}`
    );

    const [job] = await queue.findJobs(jobNames.reminderExecute, { id });
    expect(job?.retryLimit).toBe(0);
  });

  it('upserts one UTC schedule per organisation across restarts', async () => {
    const organisationId = randomUUID();

    await ensureRecurringSchedules(queue, [organisationId]);
    await ensureRecurringSchedules(queue, [organisationId]);

    const schedules = await queue.getSchedules();
    const ownedSchedules = schedules.filter((schedule) =>
      schedule.key.endsWith(`/${organisationId}`)
    );
    expect(ownedSchedules).toHaveLength(4);
    expect(ownedSchedules.every((schedule) => schedule.timezone === 'UTC')).toBe(
      true
    );
    expect(
      ownedSchedules.filter(
        (schedule) => schedule.name === jobNames.xeroIncrementalSync
      )
    ).toHaveLength(1);
  });
});
