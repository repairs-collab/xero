import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '@bc5000/db';
import { allJobNames, jobNames } from './names.js';
import { parseJobPayload } from './payloads.js';
import { ensureRecurringSchedules } from './schedules.js';

const bossState = vi.hoisted(() => ({
  work: vi.fn<(name: string, handler: (jobs: { id: string; data: unknown; signal: AbortSignal }[]) => Promise<void>) => Promise<string>>().mockResolvedValue('worker-1'),
  schedule: vi.fn<(name: string, cron: string, data: unknown, options: unknown) => Promise<void>>().mockResolvedValue(undefined),
  startCalls: 0,
  stopCalls: 0,
  stopFailures: 0,
  createQueueCalls: 0,
  failQueueCreation: true
}));

vi.mock('pg-boss', () => ({
  PgBoss: class PgBoss extends EventEmitter {
    work = bossState.work;
    schedule = bossState.schedule;
    start() {
      bossState.startCalls += 1;
      return Promise.resolve();
    }

    createQueue() {
      bossState.createQueueCalls += 1;
      if (bossState.failQueueCreation && bossState.createQueueCalls === 2) {
        bossState.failQueueCreation = false;
        return Promise.reject(new Error('create queue failed'));
      }
      return Promise.resolve();
    }

    stop() {
      bossState.stopCalls += 1;
      if (bossState.stopFailures > 0) {
        bossState.stopFailures -= 1;
        return Promise.reject(new Error('stop failed'));
      }
      return Promise.resolve();
    }
  }
}));

import {
  createTransactionalPgBossDatabase,
  DurableJobQueue
} from './queue.js';

describe.sequential('DurableJobQueue startup', () => {
  it('accepts only an empty payload for global lifecycle email dispatch', () => {
    expect(allJobNames).toContain('lifecycle-email.dispatch');
    expect(parseJobPayload(jobNames.lifecycleEmailDispatch, {})).toEqual({});
    expect(() => parseJobPayload(jobNames.lifecycleEmailDispatch, { organisationId: 'org' })).toThrow();
  });

  it('schedules a single global email dispatch every minute with no queue retries', async () => {
    const queue = new DurableJobQueue({ databaseUrl: 'postgres://unused:unused@localhost/unused' });
    await ensureRecurringSchedules(queue, ['org-a', 'org-b']);
    const emails = bossState.schedule.mock.calls.filter(([name]) => name === 'lifecycle-email.dispatch');
    expect(emails).toEqual([['lifecycle-email.dispatch', '* * * * *', {}, expect.objectContaining({
      key: 'lifecycle-email.dispatch', singletonKey: 'lifecycle-email.dispatch', tz: 'UTC', retryLimit: 0,
      expireInSeconds: 180
    })]]);
  });

  it('forwards the pg-boss cancellation signal with each registered email job', async () => {
    const queue = new DurableJobQueue({ databaseUrl: 'postgres://unused:unused@localhost/unused' });
    const handler = vi.fn(async () => {});
    await queue.register(jobNames.lifecycleEmailDispatch, handler);
    const work = bossState.work.mock.calls[0]![1];
    const job = { id: 'job-1', data: {}, signal: new AbortController().signal };
    await work([job]);
    expect(handler).toHaveBeenCalledWith(job);
  });

  it('stops a partially started pg-boss instance and permits a clean retry', async () => {
    const queue = new DurableJobQueue({
      databaseUrl: 'postgres://unused:unused@localhost/unused'
    });

    await expect(queue.start()).rejects.toThrow('create queue failed');
    expect(bossState.stopCalls).toBe(1);

    await expect(queue.start()).resolves.toBeUndefined();
    expect(bossState.startCalls).toBe(2);
    await queue.stop();
    expect(bossState.stopCalls).toBe(2);
  });

  it('fails closed instead of binding placeholders in unsupported SQL shapes', async () => {
    const execute = vi.fn();
    const database = createTransactionalPgBossDatabase({
      execute
    } as unknown as DbTransaction);

    await expect(
      database.executeSql("SELECT '$1' AS quoted, $1 AS value", ['unsafe'])
    ).rejects.toThrow('PG_BOSS_TRANSACTION_SQL_UNSUPPORTED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps partial-start state so stop can retry failed cleanup', async () => {
    bossState.createQueueCalls = 0;
    bossState.failQueueCreation = true;
    bossState.stopFailures = 2;
    const stopCallsBefore = bossState.stopCalls;
    const queue = new DurableJobQueue({
      databaseUrl: 'postgres://unused:unused@localhost/unused'
    });

    await expect(queue.start()).rejects.toThrow('create queue failed');
    expect(bossState.stopCalls).toBe(stopCallsBefore + 1);
    await expect(queue.stop()).rejects.toThrow('stop failed');
    expect(bossState.stopCalls).toBe(stopCallsBefore + 2);
    await expect(queue.stop()).resolves.toBeUndefined();
    expect(bossState.stopCalls).toBe(stopCallsBefore + 3);
  });
});
