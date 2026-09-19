import type { WorkerQueue } from './register-handlers.js';

export class InFlightJobs {
  readonly #ids = new Set<string>();

  add(id: string): void {
    this.#ids.add(id);
  }

  delete(id: string): void {
    this.#ids.delete(id);
  }

  ids(): string[] {
    return [...this.#ids].sort();
  }
}

export interface CloseableDatabase {
  close(): Promise<void>;
}

export interface ShutdownLogger {
  error(message: string, error?: unknown): void;
  warn(message: string, details?: unknown): void;
}

export interface ShutdownResult {
  failed: boolean;
  unfinishedJobIds: string[];
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function shutdownWorker(options: {
  queue: WorkerQueue;
  database: CloseableDatabase;
  inFlight: InFlightJobs;
  timeoutMs?: number;
  logger?: ShutdownLogger;
}): Promise<ShutdownResult> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const deadline = Date.now() + timeoutMs;
  let failed = false;

  try {
    await options.queue.stopClaiming();
  } catch (error) {
    failed = true;
    options.logger?.error('Failed to stop job claims', error);
  }

  while (options.inFlight.ids().length > 0 && Date.now() < deadline) {
    await wait(Math.min(10, Math.max(1, deadline - Date.now())));
  }

  const unfinishedJobIds = options.inFlight.ids();
  if (unfinishedJobIds.length > 0) {
    options.logger?.warn('Worker shutdown deadline reached', {
      unfinishedJobIds
    });
  }

  try {
    await options.queue.stop();
  } catch (error) {
    failed = true;
    options.logger?.error('Failed to close the job queue', error);
  }

  try {
    await options.database.close();
  } catch (error) {
    failed = true;
    options.logger?.error('Failed to close the database', error);
  }

  return { failed, unfinishedJobIds };
}
