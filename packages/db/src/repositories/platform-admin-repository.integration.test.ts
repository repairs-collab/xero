import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  invitations,
  memberships,
  organisations,
  platformAdminAuditEvents,
  providerConnections,
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  subscriptions,
  users,
  xeroConnections
} from '../schema/index.js';
import { PostgresPlatformAdminRepository } from './platform-admin-repository.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const repository = new PostgresPlatformAdminRepository(client.db);

const periodStart = new Date('2026-11-01T00:00:00.000Z');
const periodEnd = new Date('2026-12-01T00:00:00.000Z');

const ids = {
  alpha: randomUUID(),
  beta: randomUUID(),
  gamma: randomUUID(),
  owner: randomUUID()
};

beforeAll(async () => {
  await migrateDatabase(client.db);
  await client.db.insert(organisations).values([
    {
      id: ids.alpha,
      xeroOrganisationId: 'platform-admin-xero-alpha',
      name: 'Alpha Repairs',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO',
      lastSuccessfulSyncAt: new Date('2026-11-10T01:00:00.000Z')
    },
    {
      id: ids.beta,
      xeroOrganisationId: 'platform-admin-xero-beta',
      name: 'Beta Services',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO',
      platformStatus: 'SUSPENDED',
      suspendedAt: new Date('2026-11-09T00:00:00.000Z'),
      suspensionReason: 'Owner review',
      platformStatusVersion: 2
    },
    {
      id: ids.gamma,
      xeroOrganisationId: 'platform-admin-xero-gamma',
      name: 'Gamma Electrical',
      timeZone: 'Pacific/Auckland',
      baseCurrency: 'NZD',
      edition: 'SOLO'
    }
  ]);
  await client.db.insert(subscriptions).values([
    {
      organisationId: ids.alpha,
      planCode: 'SOLO_AU_2000',
      status: 'TRIALING',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialEndsAt: new Date('2026-11-20T00:00:00.000Z'),
      lastStripeEventCreatedAt: new Date('2026-11-10T00:00:00.000Z')
    },
    {
      organisationId: ids.beta,
      planCode: 'SOLO_AU_2000',
      status: 'ACTIVE',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      lastStripeEventCreatedAt: new Date('2026-11-10T00:00:00.000Z')
    },
    {
      organisationId: ids.gamma,
      planCode: 'SOLO_AU_2000',
      status: 'PAST_DUE',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      lastStripeEventCreatedAt: new Date('2026-11-10T00:00:00.000Z')
    }
  ]);
  await client.db.insert(users).values([
    {
      id: ids.owner,
      cognitoSubject: `subject-${ids.owner}`,
      email: 'repairs@motts.com.au',
      displayName: 'AccountPulse Owner',
      platformRole: 'OWNER'
    },
    {
      id: randomUUID(),
      cognitoSubject: `subject-beta-${ids.beta}`,
      email: 'owner@beta.example',
      displayName: 'Beta Owner'
    }
  ]);
  const betaUser = await client.db.query.users.findFirst({
    where: (table, { eq }) => eq(table.email, 'owner@beta.example')
  });
  if (!betaUser) throw new Error('Beta test user missing');
  await client.db.insert(memberships).values({
    organisationId: ids.beta,
    userId: betaUser.id,
    role: 'ADMIN'
  });
  await client.db.insert(invitations).values({
    organisationId: ids.alpha,
    email: 'invited@alpha.example',
    role: 'OPERATOR',
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    invitedByUserId: ids.owner
  });
  await client.db.insert(xeroConnections).values({
    organisationId: ids.alpha,
    connectionId: 'connection-alpha',
    tenantId: 'tenant-alpha',
    encryptedRefreshToken: {
      version: 1,
      keyId: 'secret-key-id',
      iv: 'secret-iv',
      ciphertext: 'secret-ciphertext',
      tag: 'secret-tag'
    },
    grantedScopes: ['accounting.transactions']
  });
  await client.db.insert(providerConnections).values({
    organisationId: ids.alpha,
    provider: 'SINCH',
    secretArn: 'env:SINCH_API_CREDENTIALS'
  });
  await client.db.insert(smsNumberPool).values({
    e164Number: '+61400000111',
    provider: 'SINCH',
    providerNumberId: 'sinch-number-alpha',
    status: 'READY',
    organisationId: ids.alpha,
    reservedAt: new Date('2026-11-01T00:00:00.000Z'),
    readyAt: new Date('2026-11-01T01:00:00.000Z')
  });
  await client.db.insert(smsAllowanceSettings).values({
    organisationId: ids.alpha,
    includedParts: 500,
    warningPercent: 75
  });
  await client.db.insert(smsUsageLedger).values([
    {
      organisationId: ids.alpha,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      source: 'REMINDER',
      entryType: 'RESERVE',
      partDelta: 7,
      idempotencyKey: `reserve-${ids.alpha}`
    },
    {
      organisationId: ids.alpha,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      source: 'REMINDER',
      entryType: 'COMMIT',
      partDelta: 7,
      idempotencyKey: `commit-${ids.alpha}`
    }
  ]);
  await client.db.insert(platformAdminAuditEvents).values({
    actorUserId: ids.owner,
    targetOrganisationId: ids.beta,
    eventType: 'ORGANISATION_SUSPENDED',
    entityType: 'ORGANISATION',
    entityId: ids.beta,
    reason: 'Owner review',
    afterValue: { platformStatus: 'SUSPENDED' },
    occurredAt: new Date('2026-11-09T00:00:00.000Z')
  });
});

afterAll(async () => {
  await client.pool.end();
});

describe('PostgresPlatformAdminRepository reads', () => {
  it('paginates and sorts organisations deterministically', async () => {
    const first = await repository.listOrganisations({
      search: 'platform-admin-xero-',
      page: 1,
      pageSize: 2,
      sort: 'name',
      direction: 'asc'
    });
    const second = await repository.listOrganisations({
      search: 'platform-admin-xero-',
      page: 2,
      pageSize: 2,
      sort: 'name',
      direction: 'asc'
    });

    expect(first.total).toBe(3);
    expect(first.items.map((item) => item.name)).toEqual([
      'Alpha Repairs',
      'Beta Services'
    ]);
    expect(second.items.map((item) => item.name)).toEqual(['Gamma Electrical']);
  });

  it.each([
    ['owner@beta.example', 'Beta Services'],
    ['tenant-alpha', 'Alpha Repairs'],
    ['+61400000111', 'Alpha Repairs'],
    ['xero-gamma', 'Gamma Electrical']
  ])('searches by customer and connected identifiers: %s', async (search, name) => {
    const result = await repository.listOrganisations({ search });
    expect(result.items.map((item) => item.name)).toEqual([name]);
  });

  it('aggregates current-period SMS usage and sorts by total use', async () => {
    const result = await repository.listOrganisations({
      search: 'platform-admin-xero-',
      sort: 'usage',
      direction: 'desc'
    });
    expect(result.items[0]).toMatchObject({
      id: ids.alpha,
      smsUsage: {
        includedParts: 500,
        warningPercent: 75,
        committedParts: 7,
        reservedParts: 0
      }
    });
  });

  it('returns a safe organisation detail without provider credentials', async () => {
    const detail = await repository.getOrganisationDetail(ids.alpha);
    expect(detail).toMatchObject({
      id: ids.alpha,
      xero: { tenantId: 'tenant-alpha', status: 'CONNECTED' },
      smsNumber: { e164Number: '+61400000111', status: 'READY' }
    });
    expect(detail?.invitations[0]).toMatchObject({
      email: 'invited@alpha.example',
      role: 'OPERATOR'
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('encryptedRefreshToken');
    expect(serialized).not.toContain('secretArn');
    expect(serialized).not.toContain('secret-ciphertext');
  });

  it('lists number inventory and audited owner actions without secrets', async () => {
    const numbers = await repository.listSmsNumbers({ search: 'Alpha' });
    const audit = await repository.listAuditEvents({
      organisationId: ids.beta
    });

    expect(numbers.items[0]).toMatchObject({
      e164Number: '+61400000111',
      organisationName: 'Alpha Repairs'
    });
    expect(audit.items[0]).toMatchObject({
      actorEmail: 'repairs@motts.com.au',
      organisationName: 'Beta Services',
      reason: 'Owner review'
    });
  });
});
