import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';

import { createDatabase } from '@bc5000/db';

import {
  operationalJobNames,
  purgeOrganisationOperationalJobs
} from './administration.js';
import { jobNames, type JobName } from './names.js';
import { DurableJobQueue } from './queue.js';
import { ensureRecurringSchedules } from './schedules.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const database = createDatabase(databaseUrl);
const queue = new DurableJobQueue({ databaseUrl });
const controller = new PgBoss(databaseUrl);

beforeAll(async () => {
  await queue.start();
  await controller.start();
});

afterAll(async () => {
  await controller.stop({ graceful: false, timeout: 5_000 });
  await queue.stop();
  await database.pool.end();
});

const payloadFor = (name: JobName, organisationId: string) => {
  switch (name) {
    case jobNames.xeroInvoiceRefresh:
      return { organisationId, invoiceId: randomUUID() };
    case jobNames.reminderExecute:
      return { organisationId, stageInstanceId: randomUUID() };
    case jobNames.operatorReplyExecute:
      return { organisationId, replyId: randomUUID() };
    case jobNames.testSmsExecute:
      return { organisationId, outboundMessageId: randomUUID() };
    case jobNames.providerConnectionTest:
      return { organisationId, provider: 'XERO' as const };
    case jobNames.webhookProcess:
      return {
        organisationId,
        webhookEventId: randomUUID(),
        provider: 'SINCH' as const
      };
    default:
      return { organisationId };
  }
};

const send = async (
  name: JobName,
  organisationId: string,
  options: { priority?: number; retryLimit?: number } = {}
): Promise<string> => {
  const id = await controller.send(name, payloadFor(name, organisationId), {
    singletonKey: randomUUID(),
    ...options
  });
  if (id === null) throw new Error(`Failed to seed ${name}`);
  return id;
};

const stateOf = async (name: JobName, id: string) =>
  (await controller.findJobs(name, { id }))[0]?.state;

const setState = async (
  name: JobName,
  id: string,
  state: 'active' | 'completed' | 'retry'
) => {
  await database.pool.query(
    `UPDATE pgboss.job
        SET state = $3::pgboss.job_state
      WHERE id = $1::uuid
        AND name = $2::text`,
    [id, name, state]
  );
};

describe('purgeOrganisationOperationalJobs', () => {
  it('deletes only target created and retry operational jobs and returns exact counts', async () => {
    const organisationId = randomUUID();
    const foreignOrganisationId = randomUUID();

    const activeId = await send(jobNames.reminderExecute, organisationId, {
      priority: 2_000_000_000
    });
    await setState(jobNames.reminderExecute, activeId, 'active');

    const completedId = await send(jobNames.xeroInitialSync, organisationId, {
      priority: 2_000_000_000
    });
    await setState(jobNames.xeroInitialSync, completedId, 'completed');

    const retryId = await send(
      jobNames.xeroIncrementalSync,
      organisationId,
      { priority: 2_000_000_000, retryLimit: 1 }
    );
    await setState(jobNames.xeroIncrementalSync, retryId, 'retry');
    expect(await stateOf(jobNames.xeroIncrementalSync, retryId)).toBe('retry');

    const createdTargetIds = new Map<JobName, string>();
    for (const name of operationalJobNames) {
      createdTargetIds.set(name, await send(name, organisationId));
      await send(name, foreignOrganisationId);
    }

    const excludedIds = new Map<JobName, string>();
    for (const name of [
      jobNames.providerConnectionTest,
      jobNames.retentionApply,
      jobNames.webhookProcess
    ] as const) {
      excludedIds.set(name, await send(name, organisationId));
    }

    const malformedId = await send(jobNames.reminderExecute, organisationId);
    await database.pool.query(
      `UPDATE pgboss.job
          SET data = jsonb_build_object('organisationId', $2::text)
        WHERE id = $1::uuid`,
      [malformedId, organisationId]
    );

    await ensureRecurringSchedules(queue, [organisationId]);
    const schedulesBefore = (await queue.getSchedules()).filter((schedule) =>
      schedule.key.endsWith(`/${organisationId}`)
    );

    const manifest = await database.db.transaction((transaction) =>
      purgeOrganisationOperationalJobs(transaction, { organisationId })
    );

    expect(manifest).toEqual({
      [jobNames.xeroInitialSync]: 1,
      [jobNames.xeroIncrementalSync]: 2,
      [jobNames.xeroInvoiceRefresh]: 1,
      [jobNames.xeroNightlyReconcile]: 1,
      [jobNames.remindersCalculate]: 1,
      [jobNames.voiceRemindersCalculate]: 1,
      [jobNames.voiceRemindersDispatch]: 1,
      [jobNames.reminderExecute]: 1,
      [jobNames.operatorReplyExecute]: 1,
      [jobNames.testSmsExecute]: 1
    });
    for (const [name, id] of createdTargetIds) {
      expect(await stateOf(name, id)).toBeUndefined();
    }
    expect(await stateOf(jobNames.reminderExecute, activeId)).toBe('active');
    expect(await stateOf(jobNames.xeroInitialSync, completedId)).toBe('completed');
    expect(await stateOf(jobNames.reminderExecute, malformedId)).toBe('created');
    for (const [name, id] of excludedIds) {
      expect(await stateOf(name, id)).toBe('created');
    }
    const schedulesAfter = (await queue.getSchedules()).filter((schedule) =>
      schedule.key.endsWith(`/${organisationId}`)
    );
    expect(schedulesAfter.map((schedule) => schedule.key).sort()).toEqual(
      schedulesBefore.map((schedule) => schedule.key).sort()
    );
  });

  it('uses the caller transaction so a reset rollback restores purged jobs', async () => {
    const organisationId = randomUUID();
    const id = await send(jobNames.remindersCalculate, organisationId);

    await expect(
      database.db.transaction(async (transaction) => {
        await purgeOrganisationOperationalJobs(transaction, { organisationId });
        throw new Error('ROLLBACK_TEST');
      })
    ).rejects.toThrow('ROLLBACK_TEST');

    expect(await stateOf(jobNames.remindersCalculate, id)).toBe('created');
  });

  it('rejects invalid organisation identifiers without changing queued jobs', async () => {
    const organisationId = randomUUID();
    const id = await send(jobNames.testSmsExecute, organisationId);

    await expect(
      database.db.transaction((transaction) =>
        purgeOrganisationOperationalJobs(transaction, {
          organisationId: "' OR true --"
        })
      )
    ).rejects.toThrow('INVALID_ORGANISATION_ID');

    expect(await stateOf(jobNames.testSmsExecute, id)).toBe('created');
  });
});
