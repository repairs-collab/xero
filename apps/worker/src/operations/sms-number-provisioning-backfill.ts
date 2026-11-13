import type { PostgresReplyNumberProvisioningRepository } from '@bc5000/db';
import { jobNames, type DurableJobQueue } from '@bc5000/jobs';

export const backfillPaidSmsNumberProvisioning = async (dependencies: {
  repository: Pick<
    PostgresReplyNumberProvisioningRepository,
    'listPaidOrganisationsNeedingProvisioning'
  >;
  publisher: Pick<DurableJobQueue, 'enqueueUnique'>;
  clock: { now(): Date };
}): Promise<number> => {
  const candidates =
    await dependencies.repository.listPaidOrganisationsNeedingProvisioning(
      dependencies.clock.now()
    );
  for (const candidate of candidates) {
    await dependencies.publisher.enqueueUnique(
      jobNames.smsNumberProvision,
      { organisationId: candidate.organisationId },
      [
        jobNames.smsNumberProvision,
        'paid-backfill',
        candidate.organisationId,
        candidate.currentPeriodStart.toISOString(),
        candidate.currentPeriodEnd.toISOString()
      ].join(':')
    );
  }
  return candidates.length;
};
