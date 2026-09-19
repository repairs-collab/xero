import { jobNames } from './names.js';
import type { DurableJobQueue } from './queue.js';

const scheduleDefinitions = [
  { name: jobNames.xeroIncrementalSync, cron: '*/15 * * * *' },
  { name: jobNames.xeroNightlyReconcile, cron: '0 2 * * *' },
  { name: jobNames.remindersCalculate, cron: '*/5 * * * *' },
  { name: jobNames.retentionApply, cron: '0 3 * * *' }
] as const;

export async function ensureRecurringSchedules(
  queue: DurableJobQueue,
  organisationIds: string[]
): Promise<void> {
  for (const organisationId of organisationIds) {
    for (const definition of scheduleDefinitions) {
      await queue.schedule(
        definition.name,
        definition.cron,
        { organisationId },
        {
          key: `${definition.name}/${organisationId}`,
          tz: 'UTC',
          missed: 'once',
          singletonKey: `${definition.name}:${organisationId}`
        }
      );
    }
  }
}
