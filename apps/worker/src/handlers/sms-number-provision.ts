import type { PostgresSmsCommerceRepository } from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';

export const provisionPaidSmsNumber = async (
  dependencies: {
    repository: Pick<
      PostgresSmsCommerceRepository,
      'reserveAvailableNumber' | 'markNumberReady'
    >;
    clock: { now(): Date };
  },
  payload: JobPayloads['sms-number.provision']
): Promise<'READY' | 'ALREADY_READY'> => {
  const now = dependencies.clock.now();
  const number = await dependencies.repository.reserveAvailableNumber(
    payload.organisationId,
    now
  );
  if (number.status === 'READY') return 'ALREADY_READY';
  await dependencies.repository.markNumberReady(
    payload.organisationId,
    number.id,
    now
  );
  return 'READY';
};
