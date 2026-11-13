import {
  ensureRecurringSchedules,
  type DurableJobQueue
} from '@bc5000/jobs';

import {
  registerHandlers,
  type JobHandlers
} from './register-handlers.js';
import {
  InFlightJobs,
  shutdownWorker,
  type CloseableDatabase,
  type ShutdownLogger,
  type ShutdownResult
} from './shutdown.js';

export interface WorkerRuntimeOptions {
  queue: DurableJobQueue;
  database: CloseableDatabase;
  handlers: JobHandlers;
  organisationIds: string[];
  bootstrap?: () => Promise<void>;
  logger?: ShutdownLogger;
}

export interface RunningWorker {
  shutdown(): Promise<ShutdownResult>;
}

export async function startWorker(
  options: WorkerRuntimeOptions
): Promise<RunningWorker> {
  const inFlight = new InFlightJobs();
  try {
    await options.queue.start();
    await options.bootstrap?.();
    await ensureRecurringSchedules(options.queue, options.organisationIds);
    await registerHandlers(
      options.queue,
      options.handlers,
      inFlight,
      options.logger
    );
  } catch (error) {
    await Promise.allSettled([
      options.queue.stop(),
      options.database.close()
    ]);
    throw error;
  }

  let shutdownPromise: Promise<ShutdownResult> | undefined;
  const shutdown = (): Promise<ShutdownResult> => {
    shutdownPromise ??= shutdownWorker({
      queue: options.queue,
      database: options.database,
      inFlight,
      ...(options.logger === undefined ? {} : { logger: options.logger })
    });
    return shutdownPromise;
  };

  const handleSignal = (): void => {
    void shutdown().then((result) => {
      if (result.failed) process.exitCode = 1;
    });
  };
  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);

  return { shutdown };
}
