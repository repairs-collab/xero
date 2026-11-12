import type { PostgresReplyNumberProvisioningRepository } from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';

export type SmsNumberProvisioningJobResult =
  | 'ALREADY_READY'
  | 'AWAITING_VERIFICATION'
  | 'OWNER_ACTION_REQUIRED';

export const provisionPaidSmsNumber = async (
  dependencies: {
    repository: Pick<
      PostgresReplyNumberProvisioningRepository,
      | 'loadOrganisationProvisioningState'
      | 'ensureRequestForPaidOrganisation'
    >;
    clock: { now(): Date };
  },
  payload: JobPayloads['sms-number.provision']
): Promise<SmsNumberProvisioningJobResult> => {
  const state = await dependencies.repository.loadOrganisationProvisioningState(
    payload.organisationId
  );
  if (state.kind === 'ASSIGNED_READY') return 'ALREADY_READY';
  if (state.kind === 'ASSIGNED_RESERVED') return 'AWAITING_VERIFICATION';
  if (state.kind === 'ASSIGNED_QUARANTINED') {
    return 'OWNER_ACTION_REQUIRED';
  }

  await dependencies.repository.ensureRequestForPaidOrganisation({
    organisationId: payload.organisationId,
    provider: 'SINCH',
    now: dependencies.clock.now()
  });
  return 'OWNER_ACTION_REQUIRED';
};
