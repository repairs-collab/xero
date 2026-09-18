import { DurableJobQueue } from '@bc5000/jobs';

let queuePromise: Promise<DurableJobQueue> | undefined;

export const getJobQueue = (): Promise<DurableJobQueue> => {
  queuePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
    const queue = new DurableJobQueue({ databaseUrl });
    await queue.start();
    return queue;
  })();
  return queuePromise;
};
