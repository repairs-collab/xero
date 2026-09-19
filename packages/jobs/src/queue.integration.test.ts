import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jobNames } from './names.js';
import { DurableJobQueue } from './queue.js';
import { ensureRecurringSchedules } from './schedules.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';

const queue = new DurableJobQueue({ databaseUrl });

beforeAll(async () => {
  await queue.start();
});

afterAll(async () => {
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
