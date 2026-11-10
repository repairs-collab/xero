import { describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';

import {
  accountPulseTimeZoneForXero,
  createSoloProvisioningService,
  type SoloProvisioningRepository
} from './solo-provisioning-service.js';

const identitySession: AppSession = {
  userId: 'user_owner',
  cognitoSubject: 'cognito-owner',
  displayName: 'Solo Owner',
  expiresAt: '2026-11-10T00:00:00.000Z',
  memberships: []
};

class FakeRepository implements SoloProvisioningRepository {
  inputs: Parameters<SoloProvisioningRepository['provision']>[0][] = [];
  result = { organisationId: 'org_solo', created: true };

  provision(
    input: Parameters<SoloProvisioningRepository['provision']>[0]
  ): Promise<{ organisationId: string; created: boolean }> {
    this.inputs.push(input);
    return Promise.resolve(this.result);
  }
}

describe('SoloProvisioningService', () => {
  it('maps supported Australian and New Zealand Xero time zones explicitly', () => {
    expect(accountPulseTimeZoneForXero('AUSEASTERNSTANDARDTIME')).toBe(
      'Australia/Sydney'
    );
    expect(accountPulseTimeZoneForXero('NEWZEALANDSTANDARDTIME')).toBe(
      'Pacific/Auckland'
    );
    expect(() => accountPulseTimeZoneForXero('UNKNOWN')).toThrow(
      'XERO_ORGANISATION_TIMEZONE_UNSUPPORTED'
    );
  });

  it('provisions from one pending Xero tenant and publishes one idempotent initial sync', async () => {
    const repository = new FakeRepository();
    const published: Array<{
      organisationId: string;
      singletonKey: string;
    }> = [];
    const scheduled: string[] = [];
    const service = createSoloProvisioningService({
      repository,
      clock: { now: () => new Date('2026-11-09T12:00:00.000Z') },
      ensureRecurringSchedules: (organisationId) => {
        scheduled.push(organisationId);
        return Promise.resolve();
      },
      publishInitialSync: (organisationId, singletonKey) => {
        published.push({ organisationId, singletonKey });
        return Promise.resolve();
      }
    });

    await expect(
      service.provision(identitySession, {
        pendingAuthorisationId: 'pending_solo',
        connectionId: 'connection_solo',
        tenantId: 'tenant_solo'
      })
    ).resolves.toEqual({
      organisationId: 'org_solo',
      created: true,
      initialSyncQueued: true
    });
    expect(repository.inputs).toEqual([
      {
        userId: 'user_owner',
        pendingAuthorisationId: 'pending_solo',
        connectionId: 'connection_solo',
        tenantId: 'tenant_solo',
        now: new Date('2026-11-09T12:00:00.000Z'),
        trialEndsAt: new Date('2026-11-23T12:00:00.000Z')
      }
    ]);
    expect(published).toEqual([
      {
        organisationId: 'org_solo',
        singletonKey: 'xero.initial-sync:org_solo'
      }
    ]);
    expect(scheduled).toEqual(['org_solo']);
  });

  it('retains the valid workspace and reports retryable sync when publishing fails', async () => {
    const repository = new FakeRepository();
    const service = createSoloProvisioningService({
      repository,
      clock: { now: () => new Date('2026-11-09T12:00:00.000Z') },
      ensureRecurringSchedules: () => Promise.resolve(),
      publishInitialSync: () => Promise.reject(new Error('queue unavailable'))
    });

    await expect(
      service.provision(identitySession, {
        pendingAuthorisationId: 'pending_solo',
        connectionId: 'connection_solo',
        tenantId: 'tenant_solo'
      })
    ).resolves.toEqual({
      organisationId: 'org_solo',
      created: true,
      initialSyncQueued: false
    });
    expect(repository.inputs).toHaveLength(1);
  });

  it('reuses an existing Solo workspace and republishes sync idempotently', async () => {
    const repository = new FakeRepository();
    repository.result = { organisationId: 'org_existing', created: false };
    const published: string[] = [];
    const service = createSoloProvisioningService({
      repository,
      clock: { now: () => new Date('2026-11-09T12:00:00.000Z') },
      ensureRecurringSchedules: () => Promise.resolve(),
      publishInitialSync: (organisationId) => {
        published.push(organisationId);
        return Promise.resolve();
      }
    });

    await expect(
      service.provision(identitySession, {
        pendingAuthorisationId: 'pending_retry',
        connectionId: 'connection_retry',
        tenantId: 'tenant_retry'
      })
    ).resolves.toMatchObject({
      organisationId: 'org_existing',
      created: false,
      initialSyncQueued: true
    });
    expect(published).toEqual(['org_existing']);
  });
});
