import type { PostgresReplyNumberProvisioningRepository } from '@bc5000/db';
import { jobNames, type DurableJobQueue } from '@bc5000/jobs';

export const backfillPaidSmsNumberProvisioning = async (dependencies: {
  repository: Pick<
    PostgresReplyNumberProvisioningRepository,
    'listPaidOrganisationsNeedingProvisioning'
  >;
  publisher: Pick<DurableJobQueue, 'publish'>;
  clock: { now(): Date };
}): Promise<number> => {
  const candidates =
    await dependencies.repository.listPaidOrganisationsNeedingProvisioning(
      dependencies.clock.now()
    );
  for (const candidate of candidates) {
    await dependencies.publisher.publish(
      jobNames.smsNumberProvision,
      { organisationId: candidate.organisationId },
      {
        singletonKey: [
          jobNames.smsNumberProvision,
          'paid-backfill',
          candidate.organisationId,
          candidate.currentPeriodStart.toISOString(),
          candidate.currentPeriodEnd.toISOString()
        ].join(':'),
        deduplicateWhileActive: true
      }
    );
  }
  return candidates.length;
};
