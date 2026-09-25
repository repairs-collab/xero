import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';

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

    const scheduledId = await queue.enqueueUnique(
      jobNames.xeroIncrementalSync,
      { organisationId },
      singletonKey
    );
    const manualCollisionId = await queue.publish(
      jobNames.xeroIncrementalSync,
      { organisationId },
      { singletonKey, deduplicateWhileActive: true }
    );

    expect(manualCollisionId).toBe(scheduledId);

    await queueController.complete(
      jobNames.xeroIncrementalSync,
      scheduledId,
      null,
      { includeQueued: true }
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
