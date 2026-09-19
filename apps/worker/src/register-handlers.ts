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

export async function registerHandlers(
  queue: WorkerQueue,
  handlers: JobHandlers,
  inFlight: InFlightJobs
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
      } finally {
        inFlight.delete(job.id);
      }
    });
  }
}
