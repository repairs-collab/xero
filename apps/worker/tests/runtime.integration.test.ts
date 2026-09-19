import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { jobNames, type JobName } from '@bc5000/jobs';

import {
  registerHandlers,
  type RegisteredJob,
  type WorkerHandler,
  type WorkerQueue
} from '../src/register-handlers.js';
import { InFlightJobs, shutdownWorker } from '../src/shutdown.js';

class FakeWorkerQueue implements WorkerQueue {
  handlers = new Map<JobName, WorkerHandler<JobName>>();
  stoppedClaiming = false;
  closed = false;

  register<Name extends JobName>(
    name: Name,
    handler: WorkerHandler<Name>
  ): Promise<void> {
    this.handlers.set(name, handler as WorkerHandler<JobName>);
    return Promise.resolve();
  }

  stopClaiming(): Promise<void> {
    this.stoppedClaiming = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  async run<Name extends JobName>(
    name: Name,
    job: RegisteredJob<Name>
  ): Promise<void> {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new Error(`No handler for ${name}`);
    await handler(job);
  }
}

describe('worker runtime', () => {
  it('propagates handler failures and always clears in-flight tracking', async () => {
    const queue = new FakeWorkerQueue();
    const inFlight = new InFlightJobs();
    const failure = new Error('handler failed');
    await registerHandlers(
      queue,
      {
        [jobNames.xeroInitialSync]: () => Promise.reject(failure)
      },
      inFlight
    );

    await expect(
      queue.run(jobNames.xeroInitialSync, {
        id: randomUUID(),
        data: { organisationId: randomUUID() }
      })
    ).rejects.toBe(failure);
    expect(inFlight.ids()).toEqual([]);
  });

  it('stops claiming, waits for active work, and closes resources', async () => {
    const queue = new FakeWorkerQueue();
    const inFlight = new InFlightJobs();
    const database = { close: vi.fn(() => Promise.resolve()) };
    let finish!: () => void;
    const workFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await registerHandlers(
      queue,
      {
        [jobNames.xeroInitialSync]: () => workFinished
      },
      inFlight
    );
    const running = queue.run(jobNames.xeroInitialSync, {
      id: 'active-job',
      data: { organisationId: randomUUID() }
    });

    const shutdown = shutdownWorker({
      queue,
      database,
      inFlight,
      timeoutMs: 500
    });
    await vi.waitFor(() => expect(queue.stoppedClaiming).toBe(true));
    expect(queue.closed).toBe(false);
    finish();

    await expect(shutdown).resolves.toEqual({
      failed: false,
      unfinishedJobIds: []
    });
    await running;
    expect(queue.closed).toBe(true);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('records unfinished job IDs but still closes cleanly at the deadline', async () => {
    const queue = new FakeWorkerQueue();
    const inFlight = new InFlightJobs();
    const database = { close: vi.fn(() => Promise.resolve()) };
    inFlight.add('unknown-outcome-send');

    await expect(
      shutdownWorker({ queue, database, inFlight, timeoutMs: 1 })
    ).resolves.toEqual({
      failed: false,
      unfinishedJobIds: ['unknown-outcome-send']
    });
    expect(queue.closed).toBe(true);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('rejects an invalid payload before invoking a handler', async () => {
    const queue = new FakeWorkerQueue();
    const handler = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await registerHandlers(
      queue,
      { [jobNames.xeroInitialSync]: handler },
      new InFlightJobs()
    );

    await expect(
      queue.run(jobNames.xeroInitialSync, {
        id: randomUUID(),
        data: { organisationId: '' }
      })
    ).rejects.toThrow(/organisationId/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
