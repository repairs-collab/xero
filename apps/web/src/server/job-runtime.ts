import { DurableJobQueue } from '@bc5000/jobs';

let queuePromise: Promise<DurableJobQueue> | undefined;

export const getJobQueue = (): Promise<DurableJobQueue> => {
  if (queuePromise === undefined) {
    const starting = (async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
      const queue = new DurableJobQueue({ databaseUrl });
      await queue.start();
      return queue;
    })();
    const cached = starting.catch((error: unknown) => {
      if (queuePromise === cached) queuePromise = undefined;
      throw error;
    });
    queuePromise = cached;
  }
  return queuePromise;
};
