import { createHash } from 'node:crypto';

import {
  type Db,
  PgBoss,
  type FindJobsOptions,
  type Job,
  type JobWithMetadata,
  type Schedule,
  type ScheduleOptions
} from 'pg-boss';
import { Client } from 'pg';

import type { JobPublisher, PublishOptions } from './contracts.js';
import { allJobNames, jobNames, type JobName } from './names.js';
import {
  parseJobPayload,
  type JobPayloads
} from './payloads.js';
import { runTransactionWithRetry } from './transaction-retry.js';

export interface JobQueueLogger {
  error(message: string, error?: unknown): void;
  warn(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
}

const silentLogger: JobQueueLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined
};

const safeRetryOptions = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 600,
  deleteAfterSeconds: 604_800
} as const;

const externalSendOptions = {
  retryLimit: 0,
  expireInSeconds: 120,
  deleteAfterSeconds: 2_592_000
} as const;

const optionsFor = (name: JobName) =>
  name === jobNames.reminderExecute || name === jobNames.operatorReplyExecute
    ? externalSendOptions
    : safeRetryOptions;

const stableJobId = (name: JobName, singletonKey: string): string => {
  const hex = createHash('sha256')
    .update(`${name}\0${singletonKey}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(
    16
  );
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
};

export interface DurableJobQueueOptions {
  databaseUrl: string;
  logger?: JobQueueLogger;
}

export interface RegisteredJob<Name extends JobName> {
  id: string;
  data: JobPayloads[Name];
}

export type QueueHandler<Name extends JobName> = (
  job: RegisteredJob<Name>
) => Promise<void>;

export class DurableJobQueue implements JobPublisher {
  readonly #boss: PgBoss;
  readonly #databaseUrl: string;
  readonly #logger: JobQueueLogger;
  readonly #workers = new Map<JobName, string>();
  #started = false;

  constructor(options: DurableJobQueueOptions) {
    this.#databaseUrl = options.databaseUrl;
    this.#logger = options.logger ?? silentLogger;
    this.#boss = new PgBoss(options.databaseUrl);
    this.#boss.on('error', (error) => {
      this.#logger.error('pg-boss error', error);
    });
    this.#boss.on('warning', (warning) => {
      this.#logger.warn('pg-boss warning', warning);
    });
    this.#boss.on('stopped', () => {
      this.#logger.info('pg-boss stopped');
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.#boss.start();
    for (const name of allJobNames) {
      await this.#boss.createQueue(name, {
        policy: 'stately',
        ...optionsFor(name)
      });
    }
    this.#started = true;
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    await this.#boss.stop({ graceful: false, timeout: 5_000 });
    this.#started = false;
  }

  async stopClaiming(): Promise<void> {
    const workers = [...this.#workers.entries()];
    await Promise.all(
      workers.map(([name, id]) => this.#boss.offWork(name, { id, wait: false }))
    );
    this.#workers.clear();
  }

  async enqueueUnique<Name extends JobName>(
    name: Name,
    payload: JobPayloads[Name],
    singletonKey: string,
    startAfter?: Date
  ): Promise<string> {
    if (singletonKey.trim().length === 0) {
      throw new Error('singletonKey must not be empty');
    }
    const data = parseJobPayload(name, payload);
    const id = stableJobId(name, singletonKey);
    const startOptions = startAfter === undefined ? {} : { startAfter };
    const inserted = await this.#boss.send(name, data, {
      ...optionsFor(name),
      ...startOptions,
      id,
      singletonKey
    });
    return inserted ?? id;
  }

  async publish<Name extends JobName>(
    name: Name,
    payload: JobPayloads[Name],
    options: PublishOptions = {}
  ): Promise<string> {
    const singletonKey =
      options.singletonKey ??
      createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (options.deduplicateWhileActive) {
      const data = parseJobPayload(name, payload);
      const startOptions =
        options.startAfter === undefined ? {} : { startAfter: options.startAfter };
      return runTransactionWithRetry(async () => {
        const client = new Client({
          connectionString: this.#databaseUrl,
          application_name: 'bill-chaser-active-singleton'
        });
        await client.connect();
        try {
          await client.query('BEGIN');
          const queue = await client.query<{ name: string }>(
            'SELECT name FROM pgboss.queue WHERE name = $1 FOR UPDATE',
            [name]
          );
          if (queue.rowCount !== 1) throw new Error('JOB_QUEUE_NOT_FOUND');

          const existing = await client.query<{ id: string }>(
            `SELECT id
               FROM pgboss.job
              WHERE name = $1
                AND singleton_key = $2
                AND state IN ('created', 'retry', 'active')
              ORDER BY CASE state
                WHEN 'active' THEN 0
                WHEN 'retry' THEN 1
                ELSE 2
              END, created_on DESC
              LIMIT 1
              FOR UPDATE`,
            [name, singletonKey]
          );
          const existingId = existing.rows[0]?.id;
          if (existingId !== undefined) {
            await client.query('COMMIT');
            return existingId;
          }

          const transactionalDatabase: Db = {
            executeSql: async (text, values) => {
              const result = await client.query(text, values);
              return { rows: result.rows };
            }
          };
          const inserted = await this.#boss.send(name, data, {
            ...optionsFor(name),
            ...startOptions,
            singletonKey,
            db: transactionalDatabase
          });
          if (inserted === null) {
            throw new Error('ACTIVE_SINGLETON_JOB_NOT_ENQUEUED');
          }
          await client.query('COMMIT');
          return inserted;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          await client.end();
        }
      });
    }
    return this.enqueueUnique(
      name,
      payload,
      singletonKey,
      options.startAfter
    );
  }

  async register<Name extends JobName>(
    name: Name,
    handler: QueueHandler<Name>
  ): Promise<void> {
    if (this.#workers.has(name)) return;
    const workerId = await this.#boss.work<JobPayloads[Name]>(
      name,
      async (jobs: Job<JobPayloads[Name]>[]) => {
        for (const job of jobs) {
          await handler({
            id: job.id,
            data: parseJobPayload(name, job.data)
          });
        }
      }
    );
    this.#workers.set(name, workerId);
  }

  findJobs<Name extends JobName>(
    name: Name,
    options?: FindJobsOptions
  ): Promise<JobWithMetadata<JobPayloads[Name]>[]> {
    return this.#boss.findJobs<JobPayloads[Name]>(name, options);
  }

  schedule<Name extends JobName>(
    name: Name,
    cron: string,
    payload: JobPayloads[Name],
    options: ScheduleOptions
  ): Promise<void> {
    return this.#boss.schedule(name, cron, parseJobPayload(name, payload), {
      ...optionsFor(name),
      ...options
    });
  }

  getSchedules(): Promise<Schedule[]> {
    return this.#boss.getSchedules();
  }
}
