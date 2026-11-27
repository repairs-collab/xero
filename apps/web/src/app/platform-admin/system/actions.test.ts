import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthorizationFailure } from '@bc5000/auth';

const mocks = vi.hoisted(() => ({
  requirePlatformOwner: vi.fn(),
  getDatabaseClient: vi.fn(),
  requestWorkerRepair: vi.fn(),
  revalidatePath: vi.fn()
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers())
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock('@bc5000/db/web', () => ({
  requestWorkerRepair: mocks.requestWorkerRepair
}));

vi.mock('../../../server/platform-authorization.js', () => ({
  requirePlatformOwner: mocks.requirePlatformOwner
}));

vi.mock('../../../server/runtime.js', () => ({
  getDatabaseClient: mocks.getDatabaseClient
}));

import { submitWorkerRepair } from './actions.js';

const database = {};
const serverRequestId = '00000000-0000-4000-8000-000000000007';

function confirmedForm(): FormData {
  const form = new FormData();
  form.set('confirmed', 'yes');
  return form;
}

describe('Owner worker repair submission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requirePlatformOwner.mockResolvedValue({ userId: 'verified-owner' });
    mocks.getDatabaseClient.mockReturnValue({ db: database });
    mocks.requestWorkerRepair.mockResolvedValue('REQUESTED');
  });

  it('rejects a non-owner before accessing the repair repository', async () => {
    mocks.requirePlatformOwner.mockRejectedValue(new AuthorizationFailure());

    await expect(submitWorkerRepair(serverRequestId, confirmedForm())).rejects.toBeInstanceOf(
      AuthorizationFailure
    );
    expect(mocks.getDatabaseClient).not.toHaveBeenCalled();
    expect(mocks.requestWorkerRepair).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation from the verified owner', async () => {
    await expect(submitWorkerRepair(serverRequestId, new FormData())).resolves.toBe(
      'CONFIRMATION_REQUIRED'
    );
    expect(mocks.requestWorkerRepair).not.toHaveBeenCalled();
  });

  it('queues only the fixed request with the verified actor and server nonce', async () => {
    const form = confirmedForm();
    form.set('actor', 'untrusted');
    form.set('requestId', 'untrusted');
    form.set('target', 'database');
    form.set('command', 'restart any service');
    form.set('rolloutScope', 'CONTROLLED');

    await expect(submitWorkerRepair(serverRequestId, form)).resolves.toBe('REQUESTED');
    expect(mocks.requestWorkerRepair).toHaveBeenCalledExactlyOnceWith(
      database,
      'verified-owner',
      serverRequestId
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/platform-admin/system');
  });

  it.each(['ALREADY_REQUESTED', 'COOLDOWN', 'RUNNER_UNAVAILABLE'] as const)(
    'returns the bounded request result %s',
    async (outcome) => {
      mocks.requestWorkerRepair.mockResolvedValue(outcome);
      await expect(submitWorkerRepair(serverRequestId, confirmedForm())).resolves.toBe(outcome);
    }
  );

  it('rejects owner revocation between authentication and the durable write', async () => {
    mocks.requestWorkerRepair.mockResolvedValue('NOT_OWNER');
    await expect(submitWorkerRepair(serverRequestId, confirmedForm())).rejects.toBeInstanceOf(
      AuthorizationFailure
    );
  });

  it('does not expose database errors', async () => {
    mocks.requestWorkerRepair.mockRejectedValue(new Error('private database response'));
    await expect(submitWorkerRepair(serverRequestId, confirmedForm())).resolves.toBe('UNAVAILABLE');
  });
});
