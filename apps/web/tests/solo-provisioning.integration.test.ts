import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  auditEvents,
  createDatabase,
  memberships,
  migrateDatabase,
  organisationOnboarding,
  organisations,
  reminderSequences,
  stageInstances,
  subscriptions,
  users,
  xeroConnections,
  xeroPendingAuthorisations
} from '@bc5000/db';

import {
  createPostgresSoloProvisioningRepository,
  createSoloProvisioningService
} from '../src/server/solo-provisioning-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const now = new Date('2026-11-10T00:00:00.000Z');

const tokenEnvelope = {
  version: 1,
  keyId: 'integration-test',
  iv: Buffer.alloc(12).toString('base64'),
  ciphertext: Buffer.from('encrypted-refresh-token').toString('base64'),
  tag: Buffer.alloc(16).toString('base64')
};

const seedProvisionalIdentity = async (): Promise<{
  session: AppSession;
  pendingAuthorisationId: string;
  connectionId: string;
  tenantId: string;
}> => {
  const userId = randomUUID();
  const pendingAuthorisationId = randomUUID();
  const connectionId = randomUUID();
  const tenantId = randomUUID();
  const cognitoSubject = randomUUID();
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject,
    email: `${userId}@example.invalid`,
    displayName: 'Solo Owner'
  });
  await client.db.insert(xeroPendingAuthorisations).values({
    id: pendingAuthorisationId,
    userId,
    existingOrganisationId: null,
    flowPurpose: 'NEW_SOLO',
    encryptedRefreshToken: tokenEnvelope,
    candidateTenants: [
      {
        connectionId,
        tenantId,
        tenantName: 'Candidate tenant',
        tenantType: 'ORGANISATION',
        xeroOrganisationId: randomUUID(),
        organisationName: 'Solo Repairs Pty Ltd',
        baseCurrency: 'AUD',
        timeZone: 'Australia/Sydney'
      }
    ],
    grantedScopes: ['offline_access', 'accounting.invoices'],
    expiresAt: new Date(now.getTime() + 5 * 60_000)
  });
  return {
    session: {
      userId,
      cognitoSubject,
      displayName: 'Solo Owner',
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      memberships: []
    },
    pendingAuthorisationId,
    connectionId,
    tenantId
  };
};

describe('AccountPulse Solo provisioning', () => {
  it('atomically creates one safe trial workspace and remains idempotent on retry', async () => {
    const seeded = await seedProvisionalIdentity();
    const published = new Set<string>();
    const service = createSoloProvisioningService({
      repository: createPostgresSoloProvisioningRepository(client.db),
      clock: { now: () => now },
      ensureRecurringSchedules: () => Promise.resolve(),
      publishInitialSync: (_organisationId, singletonKey) => {
        published.add(singletonKey);
        return Promise.resolve();
      }
    });
    const input = {
      pendingAuthorisationId: seeded.pendingAuthorisationId,
      connectionId: seeded.connectionId,
      tenantId: seeded.tenantId
    };

    const first = await service.provision(seeded.session, input);
    const retry = await service.provision(seeded.session, input);

    expect(first).toMatchObject({ created: true, initialSyncQueued: true });
    expect(retry).toEqual({
      organisationId: first.organisationId,
      created: false,
      initialSyncQueued: true
    });
    expect(published).toEqual(
      new Set([`xero.initial-sync:${first.organisationId}`])
    );

    const [storedOrganisation] = await client.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, first.organisationId));
    expect(storedOrganisation).toMatchObject({
      edition: 'SOLO',
      name: 'Solo Repairs Pty Ltd',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      sendMode: 'dry-run',
      rolloutScope: 'CONTROLLED',
      liveSendAcknowledged: false,
      operationalState: 'SYNC_REQUIRED'
    });

    const storedMemberships = await client.db
      .select()
      .from(memberships)
      .where(eq(memberships.organisationId, first.organisationId));
    expect(storedMemberships).toHaveLength(1);
    expect(storedMemberships[0]).toMatchObject({
      userId: seeded.session.userId,
      role: 'ADMIN',
      disabledAt: null
    });

    const storedSubscriptions = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, first.organisationId));
    expect(storedSubscriptions).toHaveLength(1);
    expect(storedSubscriptions[0]).toMatchObject({
      planCode: 'SOLO_AU_2000',
      status: 'TRIALING',
      trialEndsAt: new Date('2026-11-24T00:00:00.000Z')
    });

    const storedOnboarding = await client.db
      .select()
      .from(organisationOnboarding)
      .where(eq(organisationOnboarding.organisationId, first.organisationId));
    expect(storedOnboarding).toHaveLength(1);
    expect(storedOnboarding[0]).toMatchObject({
      version: 1,
      xeroConnectedAt: now,
      completedVersion: null
    });

    const storedConnections = await client.db
      .select()
      .from(xeroConnections)
      .where(eq(xeroConnections.organisationId, first.organisationId));
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0]).toMatchObject({
      connectionId: seeded.connectionId,
      tenantId: seeded.tenantId,
      status: 'CONNECTED'
    });
    expect(JSON.stringify(storedConnections)).not.toContain(
      'memory-only-access-token'
    );

    const provisionAudits = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, first.organisationId));
    expect(
      provisionAudits.filter(
        (event) => event.eventType === 'SOLO_WORKSPACE_PROVISIONED'
      )
    ).toHaveLength(1);

    const sequences = await client.db
      .select()
      .from(reminderSequences)
      .where(eq(reminderSequences.organisationId, first.organisationId));
    const outboundWork = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, first.organisationId));
    expect(sequences).toEqual([]);
    expect(outboundWork).toEqual([]);
  });

  it('rejects a tenant already owned elsewhere without revealing its owner', async () => {
    const first = await seedProvisionalIdentity();
    const repository = createPostgresSoloProvisioningRepository(client.db);
    const firstResult = await repository.provision({
      userId: first.session.userId,
      pendingAuthorisationId: first.pendingAuthorisationId,
      connectionId: first.connectionId,
      tenantId: first.tenantId,
      now,
      trialEndsAt: new Date('2026-11-24T00:00:00.000Z')
    });
    const second = await seedProvisionalIdentity();
    await client.db
      .update(xeroPendingAuthorisations)
      .set({
        candidateTenants: [
          {
            connectionId: first.connectionId,
            tenantId: first.tenantId,
            tenantName: 'Already connected',
            tenantType: 'ORGANISATION',
            xeroOrganisationId: randomUUID(),
            organisationName: 'Unrelated organisation',
            baseCurrency: 'AUD',
            timeZone: 'Australia/Sydney'
          }
        ]
      })
      .where(eq(xeroPendingAuthorisations.id, second.pendingAuthorisationId));

    let message = '';
    try {
      await repository.provision({
        userId: second.session.userId,
        pendingAuthorisationId: second.pendingAuthorisationId,
        connectionId: first.connectionId,
        tenantId: first.tenantId,
        now,
        trialEndsAt: new Date('2026-11-24T00:00:00.000Z')
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('XERO_TENANT_ALREADY_CONNECTED');
    expect(message).not.toContain(firstResult.organisationId);

    const secondMemberships = await client.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, second.session.userId));
    expect(secondMemberships).toEqual([]);
  });
});
