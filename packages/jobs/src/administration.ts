import type { DbTransaction } from '@bc5000/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { OperationalJobPurgeCounts } from './contracts.js';
import { jobNames, type JobName } from './names.js';
import { parseJobPayload } from './payloads.js';

export const operationalJobNames = [
  jobNames.xeroInitialSync,
  jobNames.xeroIncrementalSync,
  jobNames.xeroInvoiceRefresh,
  jobNames.xeroNightlyReconcile,
  jobNames.remindersCalculate,
  jobNames.voiceRemindersCalculate,
  jobNames.voiceRemindersDispatch,
  jobNames.reminderExecute,
  jobNames.operatorReplyExecute,
  jobNames.testSmsExecute
] as const satisfies readonly JobName[];

type OperationalJobName = (typeof operationalJobNames)[number];

const organisationIdSchema = z.uuid();
const operationalJobNameSet = new Set<string>(operationalJobNames);
const operationalJobNameSql = sql.join(
  operationalJobNames.map((name) => sql`${name}`),
  sql`, `
);

const emptyManifest = (): OperationalJobPurgeCounts => ({
  [jobNames.xeroInitialSync]: 0,
  [jobNames.xeroIncrementalSync]: 0,
  [jobNames.xeroInvoiceRefresh]: 0,
  [jobNames.xeroNightlyReconcile]: 0,
  [jobNames.remindersCalculate]: 0,
  [jobNames.voiceRemindersCalculate]: 0,
  [jobNames.voiceRemindersDispatch]: 0,
  [jobNames.reminderExecute]: 0,
  [jobNames.operatorReplyExecute]: 0,
  [jobNames.testSmsExecute]: 0
});

const isOperationalJobName = (name: string): name is OperationalJobName =>
  operationalJobNameSet.has(name);

export async function purgeOrganisationOperationalJobs(
  transaction: DbTransaction,
  input: { organisationId: string }
): Promise<OperationalJobPurgeCounts> {
  const parsedOrganisationId = organisationIdSchema.safeParse(
    input.organisationId
  );
  if (!parsedOrganisationId.success) {
    throw new Error('INVALID_ORGANISATION_ID');
  }
  const organisationId = parsedOrganisationId.data;

  const candidates = await transaction.execute<{
    id: string;
    name: string;
    data: unknown;
  }>(sql`
    SELECT id, name, data
      FROM pgboss.job
     WHERE name = ANY(ARRAY[${operationalJobNameSql}]::text[])
       AND state::text IN ('created', 'retry')
       AND data->>'organisationId' = ${organisationId}
     FOR UPDATE
  `);

  const validatedIds: string[] = [];
  for (const candidate of candidates.rows) {
    if (!isOperationalJobName(candidate.name)) continue;
    const payload = (() => {
      try {
        return parseJobPayload(candidate.name, candidate.data);
      } catch {
        return undefined;
      }
    })();
    if (payload?.organisationId !== organisationId) continue;
    validatedIds.push(candidate.id);
  }

  const manifest = emptyManifest();
  if (validatedIds.length === 0) return manifest;
  const validatedIdSql = sql.join(
    validatedIds.map((id) => sql`${id}`),
    sql`, `
  );

  const deleted = await transaction.execute<{ name: string }>(sql`
    DELETE FROM pgboss.job
     WHERE id = ANY(ARRAY[${validatedIdSql}]::uuid[])
       AND name = ANY(ARRAY[${operationalJobNameSql}]::text[])
       AND state::text IN ('created', 'retry')
       AND data->>'organisationId' = ${organisationId}
    RETURNING name
  `);

  for (const row of deleted.rows) {
    if (isOperationalJobName(row.name)) manifest[row.name] += 1;
  }
  return manifest;
}
