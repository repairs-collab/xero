import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { AuthorizationFailure } from '@bc5000/auth';
import { requestWorkerRepair } from '@bc5000/db/web';

import { requirePlatformOwner } from '../../../server/platform-authorization.js';
import { getDatabaseClient } from '../../../server/runtime.js';

export type WorkerRepairActionOutcome =
  | 'REQUESTED'
  | 'ALREADY_REQUESTED'
  | 'COOLDOWN'
  | 'RUNNER_UNAVAILABLE'
  | 'CONFIRMATION_REQUIRED'
  | 'UNAVAILABLE';

export async function submitWorkerRepair(
  requestId: string,
  formData: FormData
): Promise<WorkerRepairActionOutcome> {
  const session = await requirePlatformOwner(
    new Request('http://localhost/platform-admin/system', {
      headers: await headers()
    })
  );
  const confirmation = formData.getAll('confirmed');
  if (confirmation.length !== 1 || confirmation[0] !== 'yes') {
    return 'CONFIRMATION_REQUIRED';
  }

  let outcome: Awaited<ReturnType<typeof requestWorkerRepair>>;
  try {
    outcome = await requestWorkerRepair(getDatabaseClient().db, session.userId, requestId);
  } catch {
    return 'UNAVAILABLE';
  }
  if (outcome === 'NOT_OWNER') throw new AuthorizationFailure();
  if (outcome === 'INVALID_REQUEST') return 'UNAVAILABLE';

  revalidatePath('/platform-admin/system');
  return outcome;
}
