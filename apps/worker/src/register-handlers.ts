import {
  allJobNames,
  parseJobPayload,
  type JobName,
  type JobPayloads
} from '@bc5000/jobs';

import type { InFlightJobs } from './shutdown.js';

export interface RegisteredJob<Name extends JobName> {
  id: string;
  data: JobPayloads[Name];
}

export type WorkerHandler<Name extends JobName> = (
  job: RegisteredJob<Name>
) => Promise<void>;

export interface WorkerQueue {
  register<Name extends JobName>(
    name: Name,
    handler: WorkerHandler<Name>
  ): Promise<void>;
  stopClaiming(): Promise<void>;
  stop(): Promise<void>;
}

export type JobHandlers = Partial<{
  [Name in JobName]: (payload: JobPayloads[Name]) => Promise<void>;
}>;

export interface WorkerFailureLogger {
  error(message: string, details?: unknown): void;
}

const numericErrorProperty = (
  error: unknown,
  name: string
): number | null | undefined => {
  if (typeof error !== 'object' || error === null || !(name in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[name];
  return typeof value === 'number' || value === null ? value : undefined;
};

const stringErrorProperty = (
  error: unknown,
  name: string
): string | null | undefined => {
  if (typeof error !== 'object' || error === null || !(name in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[name];
  return typeof value === 'string' || value === null ? value : undefined;
};

const failureDetails = (
  name: JobName,
  jobId: string,
  error: unknown
): Record<string, unknown> => ({
  jobName: name,
  jobId,
  errorName: error instanceof Error ? error.name : 'UnknownError',
  errorMessage: error instanceof Error ? error.message : 'Unknown error',
  ...(numericErrorProperty(error, 'status') === undefined
    ? {}
    : { status: numericErrorProperty(error, 'status') }),
  ...(numericErrorProperty(error, 'retryAfterSeconds') === undefined
    ? {}
    : {
        retryAfterSeconds: numericErrorProperty(error, 'retryAfterSeconds')
      }),
  ...(numericErrorProperty(error, 'dailyRemaining') === undefined
    ? {}
    : { dailyRemaining: numericErrorProperty(error, 'dailyRemaining') }),
  ...(stringErrorProperty(error, 'problem') === undefined
    ? {}
    : { rateLimitProblem: stringErrorProperty(error, 'problem') })
});

export async function registerHandlers(
  queue: WorkerQueue,
  handlers: JobHandlers,
  inFlight: InFlightJobs,
  logger?: WorkerFailureLogger
): Promise<void> {
  for (const name of allJobNames) {
    const handler = handlers[name] as
      | ((payload: JobPayloads[typeof name]) => Promise<void>)
      | undefined;
    if (handler === undefined) continue;

    await queue.register(name, async (job) => {
      const payload = parseJobPayload(name, job.data);
      inFlight.add(job.id);
      try {
        await handler(payload);
      } catch (error) {
        logger?.error('Worker job failed', failureDetails(name, job.id, error));
        throw error;
      } finally {
        inFlight.delete(job.id);
      }
    });
  }
}
