import { afterEach, describe, expect, it, vi } from 'vitest';

const queueState = vi.hoisted(() => ({
  constructions: 0,
  starts: 0,
  failNextStart: true
}));

vi.mock('@bc5000/jobs', () => ({
  DurableJobQueue: class DurableJobQueue {
    readonly instance: number;

    constructor() {
      queueState.constructions += 1;
      this.instance = queueState.constructions;
    }

    start() {
      queueState.starts += 1;
      if (queueState.failNextStart) {
        queueState.failNextStart = false;
        return Promise.reject(new Error('queue unavailable'));
      }
      return Promise.resolve();
    }
  }
}));

import { getJobQueue } from './job-runtime.js';

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe.sequential('web job runtime', () => {
  it('retries queue startup after a rejected cached attempt', async () => {
    process.env.DATABASE_URL = 'postgres://accountpulse:test@localhost/accountpulse';

    await expect(getJobQueue()).rejects.toThrow('queue unavailable');
    const queue = await getJobQueue();

    expect(queueState.constructions).toBe(2);
    expect(queueState.starts).toBe(2);
    expect(queue).toMatchObject({ instance: 2 });
  });
});
