import { randomInt, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  billingCases,
  invitations,
  memberships,
  organisations,
  platformAdminAuditEvents,
  providerConnections,
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  subscriptions,
  transactionalEmailOutbox,
  users,
  xeroConnections
} from '../schema/index.js';
import { PostgresPlatformAdminRepository } from './platform-admin-repository.js';
import { PostgresSmsCommerceRepository } from './sms-commerce-repository.js';

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
const runId = randomUUID();
const phoneBase = randomInt(10_000_000, 90_000_000);
const phone = (offset: number) => `+614${phoneBase + offset}`;
const betaEmail = `owner-${runId}@beta.example`;
const inviteEmail = `invited-${runId}@alpha.example`;
const ownerEmail = `repairs+${runId}@motts.com.au`;
const providerId = (suffix: string) => `sinch-${runId}-${suffix}`;
const xeroConnectionId = `connection-alpha-${runId}`;
const xeroTenantId = `tenant-alpha-${runId}`;
const organisationNames = {
  alpha: `Alpha Repairs ${runId}`,
  beta: `Beta Services ${runId}`,
  gamma: `Gamma Electrical ${runId}`
};

beforeAll(async () => {
  await migrateDatabase(client.db);
  await client.db.insert(organisations).values([
    {
      id: ids.alpha,
      xeroOrganisationId: `platform-admin-xero-alpha-${runId}`,
      name: organisationNames.alpha,
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO',
      lastSuccessfulSyncAt: new Date('2026-11-10T01:00:00.000Z')
    },
    {
      id: ids.beta,
      xeroOrganisationId: `platform-admin-xero-beta-${runId}`,
      name: organisationNames.beta,
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
      xeroOrganisationId: `platform-admin-xero-gamma-${runId}`,
      name: organisationNames.gamma,
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
      email: ownerEmail,
      displayName: 'AccountPulse Owner',
      platformRole: 'OWNER'
    },
    {
      id: randomUUID(),
      cognitoSubject: `subject-beta-${ids.beta}`,
      email: betaEmail,
      displayName: 'Beta Owner'
    }
  ]);
  const betaUser = await client.db.query.users.findFirst({
    where: (table, { eq }) => eq(table.email, betaEmail)
  });
  if (!betaUser) throw new Error('Beta test user missing');
  await client.db.insert(memberships).values({
    organisationId: ids.beta,
    userId: betaUser.id,
    role: 'ADMIN'
  });
  await client.db.insert(invitations).values({
    organisationId: ids.alpha,
    email: inviteEmail,
    role: 'OPERATOR',
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    invitedByUserId: ids.owner
  });
  await client.db.insert(xeroConnections).values({
    organisationId: ids.alpha,
    connectionId: xeroConnectionId,
    tenantId: xeroTenantId,
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
    e164Number: phone(1),
    provider: 'SINCH',
    providerNumberId: providerId('alpha'),
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
      search: runId,
      page: 1,
      pageSize: 2,
      sort: 'name',
      direction: 'asc'
    });
    const second = await repository.listOrganisations({
      search: runId,
      page: 2,
      pageSize: 2,
      sort: 'name',
      direction: 'asc'
    });

    expect(first.total).toBe(3);
    expect(first.items.map((item) => item.name)).toEqual([
      organisationNames.alpha,
      organisationNames.beta
    ]);
    expect(second.items.map((item) => item.name)).toEqual([organisationNames.gamma]);
  });

  it.each([
    [betaEmail, organisationNames.beta],
    [xeroTenantId, organisationNames.alpha],
    [phone(1), organisationNames.alpha],
    [`platform-admin-xero-gamma-${runId}`, organisationNames.gamma]
  ])('searches by customer and connected identifiers: %s', async (search, name) => {
    const result = await repository.listOrganisations({ search });
    expect(result.items.map((item) => item.name)).toEqual([name]);
  });

  it('aggregates current-period SMS usage and sorts by total use', async () => {
    const result = await repository.listOrganisations({
      search: runId,
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
      xero: { tenantId: xeroTenantId, status: 'CONNECTED' },
      smsNumber: { e164Number: phone(1), status: 'READY' }
    });
    expect(detail?.invitations[0]).toMatchObject({
      email: inviteEmail,
      role: 'OPERATOR'
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('encryptedRefreshToken');
    expect(serialized).not.toContain('secretArn');
    expect(serialized).not.toContain('secret-ciphertext');
  });

  it('lists number inventory and audited owner actions without secrets', async () => {
    const numbers = await repository.listSmsNumbers({ search: phone(1) });
    const audit = await repository.listAuditEvents({
      organisationId: ids.beta
    });

    expect(numbers.items[0]).toMatchObject({
      e164Number: phone(1),
      organisationName: organisationNames.alpha
    });
    expect(audit.items[0]).toMatchObject({
      actorEmail: ownerEmail,
      organisationName: organisationNames.beta,
      reason: 'Owner review'
    });
  });

  it('lists billing cases and held notices with independent stable cursors and safe fields', async () => {
    const created = [
      new Date('2026-11-11T03:00:00.000Z'),
      new Date('2026-11-11T02:00:00.000Z'),
      new Date('2026-11-11T01:00:00.000Z')
    ];
    const caseRows = await client.db
      .insert(billingCases)
      .values([
        {
          organisationId: ids.alpha,
          kind: 'DISPUTE',
          status: 'OPEN',
          providerObjectType: 'DISPUTE',
          providerObjectId: `dp-new-${runId}`,
          providerStatus: 'needs_response',
          stripeSubscriptionId: `sub-billing-${runId}`,
          subscriptionRelation: 'CURRENT',
          amountMinor: 30_000,
          currency: 'aud',
          blocksSending: true,
          latestProviderEventId: `evt-secret-new-${runId}`,
          latestProviderEventCreatedAt: created[0]!,
          openedAt: created[0]!,
          createdAt: created[0]!,
          updatedAt: created[0]!
        },
        {
          organisationId: ids.alpha,
          kind: 'REFUND',
          status: 'REVIEW_REQUIRED',
          providerObjectType: 'CHARGE',
          providerObjectId: `ch-middle-${runId}`,
          providerStatus: 'refunded',
          stripeSubscriptionId: `sub-billing-${runId}`,
          subscriptionRelation: 'RETIRED',
          amountMinor: 20_000,
          currency: 'aud',
          blocksSending: false,
          latestProviderEventId: `evt-secret-middle-${runId}`,
          latestProviderEventCreatedAt: created[1]!,
          openedAt: created[1]!,
          createdAt: created[1]!,
          updatedAt: created[1]!
        },
        {
          organisationId: ids.alpha,
          kind: 'PAYMENT_FAILURE',
          status: 'OPEN',
          providerObjectType: 'INVOICE',
          providerObjectId: `in-old-${runId}`,
          providerStatus: 'open',
          stripeSubscriptionId: `sub-billing-${runId}`,
          subscriptionRelation: 'CURRENT',
          amountMinor: 10_000,
          currency: 'aud',
          blocksSending: true,
          latestProviderEventId: `evt-secret-old-${runId}`,
          latestProviderEventCreatedAt: created[2]!,
          openedAt: created[2]!,
          createdAt: created[2]!,
          updatedAt: created[2]!
        }
      ])
      .returning({ id: billingCases.id, createdAt: billingCases.createdAt });
    const templates = [
      'DISPUTE_OPENED',
      'REFUND_RECORDED',
      'PAYMENT_FAILED'
    ] as const;
    await client.db.insert(transactionalEmailOutbox).values(
      caseRows.map((billingCase, index) => ({
        organisationId: ids.alpha,
        billingCaseId: billingCase.id,
        recipient: `billing-${index}-${runId}@alpha.example`,
        template: templates[index]!,
        renderData: { privateDetail: `never-render-${index}-${runId}` },
        idempotencyKey: `billing-queue-${index}-${runId}`,
        status: 'HELD' as const,
        createdAt: billingCase.createdAt,
        updatedAt: billingCase.createdAt
      }))
    );

    const first = await repository.listBillingOperations({
      organisationId: ids.alpha,
      limit: 2
    });
    const nextCases = await repository.listBillingOperations({
      organisationId: ids.alpha,
      limit: 2,
      casesCursor: first.cases.nextCursor!
    });
    const nextHeldEmails = await repository.listBillingOperations({
      organisationId: ids.alpha,
      limit: 2,
      heldEmailsCursor: first.heldEmails.nextCursor!
    });
    const filtered = await repository.listBillingOperations({
      organisationId: ids.alpha,
      caseKind: 'PAYMENT_FAILURE',
      caseStatus: 'OPEN',
      limit: 10
    });

    expect(first.cases.items.map((item) => item.providerReference)).toEqual([
      `dp-new-${runId}`,
      `ch-middle-${runId}`
    ]);
    expect(first.heldEmails.items).toHaveLength(2);
    expect(first.cases.nextCursor).toEqual(expect.any(String));
    expect(first.heldEmails.nextCursor).toEqual(expect.any(String));
    expect(nextCases.cases.items.map((item) => item.providerReference)).toEqual([
      `in-old-${runId}`
    ]);
    expect(nextCases.heldEmails.items.map((item) => item.id)).toEqual(
      first.heldEmails.items.map((item) => item.id)
    );
    expect(nextHeldEmails.cases.items.map((item) => item.id)).toEqual(
      first.cases.items.map((item) => item.id)
    );
    expect(nextHeldEmails.heldEmails.items).toHaveLength(1);
    expect(filtered.cases.items).toHaveLength(1);
    expect(filtered.cases.items[0]).toMatchObject({
      organisationId: ids.alpha,
      organisationName: organisationNames.alpha,
      kind: 'PAYMENT_FAILURE',
      status: 'OPEN',
      amountMinor: 10_000,
      currency: 'aud',
      providerReference: `in-old-${runId}`,
      subscriptionRelation: 'CURRENT',
      blocksSending: true
    });
    const serialized = JSON.stringify({ first, nextCases, nextHeldEmails, filtered });
    expect(serialized).not.toContain('renderData');
    expect(serialized).not.toContain('idempotencyKey');
    expect(serialized).not.toContain('latestProviderEventId');
    expect(serialized).not.toContain('evt-secret');
    expect(serialized).not.toContain('never-render');
  });
});

const seedTrialOrganisation = async (label: string) => {
  const organisationId = randomUUID();
  const updatedAt = new Date('2026-11-10T00:00:00.000Z');
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: `platform-trial-${organisationId}`,
    name: label,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO'
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: 'TRIALING',
    currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-11-20T00:00:00.000Z'),
    trialEndsAt: new Date('2026-11-20T00:00:00.000Z'),
    lastStripeEventCreatedAt: new Date('2026-11-10T00:00:00.000Z'),
    updatedAt
  });
  return { organisationId, updatedAt };
};

describe('PostgresPlatformAdminRepository mutations', () => {
  it('extends a trial without resetting its allowance period and audits atomically', async () => {
    const seeded = await seedTrialOrganisation('Trial extension target');
    await client.db.insert(smsUsageLedger).values([
      {
        organisationId: seeded.organisationId,
        billingPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
        billingPeriodEnd: new Date('2026-11-20T00:00:00.000Z'),
        source: 'REMINDER',
        entryType: 'RESERVE',
        partDelta: 23,
        idempotencyKey: `trial-reserve-${seeded.organisationId}`
      },
      {
        organisationId: seeded.organisationId,
        billingPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
        billingPeriodEnd: new Date('2026-11-20T00:00:00.000Z'),
        source: 'REMINDER',
        entryType: 'COMMIT',
        partDelta: 23,
        idempotencyKey: `trial-commit-${seeded.organisationId}`
      }
    ]);
    const result = await repository.extendTrial({
      actorUserId: ids.owner,
      organisationId: seeded.organisationId,
      newEnd: new Date('2026-11-30T00:00:00.000Z'),
      expectedUpdatedAt: seeded.updatedAt,
      reason: 'Approved beta extension',
      now: new Date('2026-11-11T00:00:00.000Z')
    });

    expect(result).toMatchObject({ ok: true });
    const stored = await client.db.query.subscriptions.findFirst({
      where: (table, { eq }) => eq(table.organisationId, seeded.organisationId)
    });
    expect(stored).toMatchObject({
      currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-11-30T00:00:00.000Z'),
      trialEndsAt: new Date('2026-11-30T00:00:00.000Z')
    });
    await expect(
      new PostgresSmsCommerceRepository(client.db).loadUsage(
        seeded.organisationId
      )
    ).resolves.toMatchObject({ committedParts: 23, reservedParts: 0 });
    expect(result).toMatchObject({
      ok: true,
      value: { smsUsage: { committedParts: 23, reservedParts: 0 } }
    });
    const audit = await repository.listAuditEvents({
      organisationId: seeded.organisationId,
      eventType: 'TRIAL_EXTENDED'
    });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]?.reason).toBe('Approved beta extension');
  });

  it('rejects stale or non-trial subscription changes without partial audit data', async () => {
    const seeded = await seedTrialOrganisation('Stale trial target');
    await client.db
      .update(subscriptions)
      .set({
        status: 'ACTIVE',
        updatedAt: new Date('2026-11-10T00:05:00.000Z')
      })
      .where(eq(subscriptions.organisationId, seeded.organisationId));

    const result = await repository.extendTrial({
      actorUserId: ids.owner,
      organisationId: seeded.organisationId,
      newEnd: new Date('2026-11-30T00:00:00.000Z'),
      expectedUpdatedAt: seeded.updatedAt,
      reason: 'Must not apply',
      now: new Date('2026-11-11T00:00:00.000Z')
    });
    const audit = await repository.listAuditEvents({
      organisationId: seeded.organisationId
    });

    expect(result).toEqual({ ok: false, code: 'CONFLICT' });
    expect(audit.items).toHaveLength(0);
  });

  it('ends a current trial using server time', async () => {
    const seeded = await seedTrialOrganisation('Trial end target');
    const now = new Date('2026-11-11T05:30:00.000Z');
    const result = await repository.endTrial({
      actorUserId: ids.owner,
      organisationId: seeded.organisationId,
      expectedUpdatedAt: seeded.updatedAt,
      reason: 'Customer requested immediate start',
      now
    });
    const stored = await client.db.query.subscriptions.findFirst({
      where: (table, { eq }) => eq(table.organisationId, seeded.organisationId)
    });

    expect(result).toMatchObject({ ok: true });
    expect(stored?.trialEndsAt).toEqual(now);
    expect(stored?.currentPeriodEnd).toEqual(now);
  });

  it('suspends and reactivates with optimistic versions and idempotent same-reason retries', async () => {
    const organisationId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `platform-status-${organisationId}`,
      name: 'Platform status target',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });

    const suspended = await repository.suspendOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Payment review',
      expectedVersion: 0,
      now: new Date('2026-11-11T00:00:00.000Z')
    });
    const retried = await repository.suspendOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Payment review',
      expectedVersion: 1,
      now: new Date('2026-11-11T00:01:00.000Z')
    });
    const stale = await repository.reactivateOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Resolved',
      expectedVersion: 0,
      now: new Date('2026-11-11T00:02:00.000Z')
    });
    const reactivated = await repository.reactivateOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Resolved',
      expectedVersion: 1,
      now: new Date('2026-11-11T00:03:00.000Z')
    });

    expect(suspended).toMatchObject({ ok: true, value: { platformStatusVersion: 1 } });
    expect(retried).toMatchObject({ ok: true, value: { platformStatusVersion: 1 } });
    expect(stale).toEqual({ ok: false, code: 'CONFLICT' });
    expect(reactivated).toMatchObject({ ok: true, value: { platformStatus: 'ACTIVE', platformStatusVersion: 2 } });
  });

  it('rejects reactivation while blocking financial cases remain without changing account state or owner audit', async () => {
    const organisationId = randomUUID();
    const suspendedAt = new Date('2026-11-11T00:10:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `platform-risk-hold-${organisationId}`,
      name: 'Financial risk hold target',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await repository.suspendOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Stripe payment failure',
      expectedVersion: 0,
      now: suspendedAt
    });
    await client.db.insert(billingCases).values({
      organisationId,
      kind: 'PAYMENT_FAILURE',
      status: 'OPEN',
      providerObjectType: 'INVOICE',
      providerObjectId: `in_${randomUUID()}`,
      providerStatus: 'payment_failed',
      stripeSubscriptionId: `sub_${randomUUID()}`,
      subscriptionRelation: 'CURRENT',
      amountMinor: 12_345,
      currency: 'aud',
      blocksSending: true,
      latestProviderEventId: `evt_${randomUUID()}`,
      latestProviderEventCreatedAt: suspendedAt,
      openedAt: suspendedAt
    });

    const stale = await repository.reactivateOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Payment confirmed manually',
      expectedVersion: 0,
      now: new Date('2026-11-11T00:11:00.000Z')
    });
    const held = await repository.reactivateOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Payment confirmed manually',
      expectedVersion: 1,
      now: new Date('2026-11-11T00:12:00.000Z')
    });
    const stored = await client.db.query.organisations.findFirst({
      where: (table, { eq }) => eq(table.id, organisationId)
    });
    const audit = await repository.listAuditEvents({ organisationId });

    expect(stale).toEqual({ ok: false, code: 'CONFLICT' });
    expect(held).toEqual({ ok: false, code: 'BILLING_RISK_HOLD' });
    expect(stored).toMatchObject({
      platformStatus: 'SUSPENDED',
      platformStatusVersion: 1,
      suspendedAt,
      suspensionReason: 'Stripe payment failure'
    });
    expect(audit.items.map((event) => event.eventType)).toEqual([
      'ORGANISATION_SUSPENDED'
    ]);
  });

  it('permits reactivation after every blocking financial case is resolved', async () => {
    const organisationId = randomUUID();
    const openedAt = new Date('2026-11-11T00:20:00.000Z');
    const resolvedAt = new Date('2026-11-11T00:21:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `platform-resolved-risk-${organisationId}`,
      name: 'Resolved financial risk target',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      platformStatus: 'SUSPENDED',
      platformStatusVersion: 1,
      suspendedAt: openedAt,
      suspensionReason: 'Dispute opened'
    });
    const [billingCase] = await client.db
      .insert(billingCases)
      .values({
        organisationId,
        kind: 'DISPUTE',
        status: 'OPEN',
        providerObjectType: 'DISPUTE',
        providerObjectId: `dp_${randomUUID()}`,
        providerStatus: 'needs_response',
        stripeSubscriptionId: `sub_${randomUUID()}`,
        subscriptionRelation: 'CURRENT',
        amountMinor: 23_456,
        currency: 'aud',
        blocksSending: true,
        latestProviderEventId: `evt_${randomUUID()}`,
        latestProviderEventCreatedAt: openedAt,
        openedAt
      })
      .returning({ id: billingCases.id });
    await client.db
      .update(billingCases)
      .set({
        status: 'RESOLVED',
        providerStatus: 'won',
        resolvedAt,
        updatedAt: resolvedAt
      })
      .where(eq(billingCases.id, billingCase!.id));

    const reactivated = await repository.reactivateOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Dispute resolved in our favour',
      expectedVersion: 1,
      now: new Date('2026-11-11T00:22:00.000Z')
    });

    expect(reactivated).toMatchObject({
      ok: true,
      value: { platformStatus: 'ACTIVE', platformStatusVersion: 2 }
    });
  });

  it('rejects an active-status shortcut when a blocking review case remains unresolved', async () => {
    const organisationId = randomUUID();
    const openedAt = new Date('2026-11-11T00:25:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `platform-blocking-review-${organisationId}`,
      name: 'Blocking review target',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(billingCases).values({
      organisationId,
      kind: 'DISPUTE',
      status: 'REVIEW_REQUIRED',
      providerObjectType: 'DISPUTE',
      providerObjectId: `dp_${randomUUID()}`,
      providerStatus: 'lost',
      stripeSubscriptionId: `sub_${randomUUID()}`,
      subscriptionRelation: 'CURRENT',
      amountMinor: 8_765,
      currency: 'aud',
      blocksSending: true,
      latestProviderEventId: `evt_${randomUUID()}`,
      latestProviderEventCreatedAt: openedAt,
      openedAt
    });

    const held = await repository.reactivateOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Attempted duplicate reactivation',
      expectedVersion: 0,
      now: new Date('2026-11-11T00:26:00.000Z')
    });
    const stored = await client.db.query.organisations.findFirst({
      where: (table, { eq }) => eq(table.id, organisationId)
    });
    const audit = await repository.listAuditEvents({ organisationId });

    expect(held).toEqual({ ok: false, code: 'BILLING_RISK_HOLD' });
    expect(stored).toMatchObject({
      platformStatus: 'ACTIVE',
      platformStatusVersion: 0,
      suspensionReason: null
    });
    expect(audit.items).toHaveLength(0);
  });

  it('permits reactivation when a financial review case does not block sending', async () => {
    const organisationId = randomUUID();
    const openedAt = new Date('2026-11-11T00:30:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `platform-refund-review-${organisationId}`,
      name: 'Non-blocking refund review target',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      platformStatus: 'SUSPENDED',
      platformStatusVersion: 1,
      suspendedAt: openedAt,
      suspensionReason: 'Manual review'
    });
    await client.db.insert(billingCases).values({
      organisationId,
      kind: 'REFUND',
      status: 'REVIEW_REQUIRED',
      providerObjectType: 'CHARGE',
      providerObjectId: `ch_${randomUUID()}`,
      providerStatus: 'refunded',
      stripeSubscriptionId: `sub_${randomUUID()}`,
      subscriptionRelation: 'CURRENT',
      amountMinor: 3_456,
      currency: 'aud',
      blocksSending: false,
      latestProviderEventId: `evt_${randomUUID()}`,
      latestProviderEventCreatedAt: openedAt,
      openedAt
    });

    const reactivated = await repository.reactivateOrganisation({
      actorUserId: ids.owner,
      organisationId,
      reason: 'Refund review does not restrict service',
      expectedVersion: 1,
      now: new Date('2026-11-11T00:31:00.000Z')
    });

    expect(reactivated).toMatchObject({
      ok: true,
      value: { platformStatus: 'ACTIVE', platformStatusVersion: 2 }
    });
  });

  it('registers only unique Australian Sinch numbers and provider identifiers', async () => {
    const now = new Date('2026-11-11T06:00:00.000Z');
    await expect(repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: '0400000222',
      provider: 'SINCH',
      providerNumberId: 'sinch-bad-format',
      reason: 'Add purchased number',
      now
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });

    const created = await repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: phone(2),
      provider: 'SINCH',
      providerNumberId: providerId('222'),
      reason: 'Add purchased number',
      now
    });
    const duplicateNumber = await repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: phone(2),
      provider: 'SINCH',
      providerNumberId: providerId('other'),
      reason: 'Duplicate check',
      now
    });
    const duplicateProviderId = await repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: phone(3),
      provider: 'SINCH',
      providerNumberId: providerId('222'),
      reason: 'Duplicate provider check',
      now
    });

    expect(created).toMatchObject({
      ok: true,
      value: {
        e164Number: phone(2),
        status: 'AVAILABLE',
        providerVerifiedAt: null
      }
    });
    expect(duplicateNumber).toEqual({ ok: false, code: 'CONFLICT' });
    expect(duplicateProviderId).toEqual({ ok: false, code: 'CONFLICT' });
  });

  it('records owner verification while leaving a number available for automatic allocation', async () => {
    const now = new Date('2026-11-11T06:05:00.000Z');
    const verifiedAt = new Date('2026-11-11T06:05:01.000Z');
    const registered = await repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: phone(8),
      provider: 'SINCH',
      providerNumberId: null,
      reason: 'Add number for verification',
      now
    });
    if (!registered.ok) throw new Error('NUMBER_SETUP_FAILED');

    const verified = await repository.verifySmsNumberForPool({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      expectedUpdatedAt: registered.value.updatedAt,
      providerNumberId: providerId('888'),
      reason: 'Ownership, outbound and inbound checks passed',
      now: verifiedAt
    });

    expect(verified).toMatchObject({
      ok: true,
      value: {
        status: 'AVAILABLE',
        organisationId: null,
        providerNumberId: providerId('888'),
        providerVerifiedAt: verifiedAt
      }
    });
    await expect(repository.verifySmsNumberForPool({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      expectedUpdatedAt: registered.value.updatedAt,
      providerNumberId: providerId('888'),
      reason: 'Stale verification attempt',
      now: verifiedAt
    })).resolves.toEqual({ ok: false, code: 'CONFLICT' });
  });

  it('serializes assignment and permits only one active number per organisation', async () => {
    const now = new Date('2026-11-11T06:10:00.000Z');
    const firstOrganisationId = randomUUID();
    const secondOrganisationId = randomUUID();
    await client.db.insert(organisations).values([
      {
        id: firstOrganisationId,
        xeroOrganisationId: `number-first-${firstOrganisationId}`,
        name: 'Number First',
        timeZone: 'Australia/Sydney',
        baseCurrency: 'AUD'
      },
      {
        id: secondOrganisationId,
        xeroOrganisationId: `number-second-${secondOrganisationId}`,
        name: 'Number Second',
        timeZone: 'Australia/Sydney',
        baseCurrency: 'AUD'
      }
    ]);
    const registered = await repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: phone(4),
      provider: 'SINCH',
      providerNumberId: null,
      reason: 'Concurrent assignment test',
      now
    });
    if (!registered.ok) throw new Error('NUMBER_SETUP_FAILED');

    await expect(repository.assignSmsNumber({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      organisationId: firstOrganisationId,
      expectedStatus: 'AVAILABLE',
      expectedUpdatedAt: new Date('2000-01-01T00:00:00.000Z'),
      reason: 'Stale assignment must fail',
      now
    })).resolves.toEqual({ ok: false, code: 'CONFLICT' });

    const results = await Promise.all([
      repository.assignSmsNumber({
        actorUserId: ids.owner,
        numberId: registered.value.id,
        organisationId: firstOrganisationId,
        expectedStatus: 'AVAILABLE',
        expectedUpdatedAt: registered.value.updatedAt,
        reason: 'Assign first customer',
        now
      }),
      repository.assignSmsNumber({
        actorUserId: ids.owner,
        numberId: registered.value.id,
        organisationId: secondOrganisationId,
        expectedStatus: 'AVAILABLE',
        expectedUpdatedAt: registered.value.updatedAt,
        reason: 'Assign second customer',
        now
      })
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: 'CONFLICT' }
    ]);

    const winner = results.find((result) => result.ok);
    if (!winner?.ok || winner.value.organisationId === null) {
      throw new Error('ASSIGNMENT_WINNER_MISSING');
    }
    const secondNumber = await repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: phone(5),
      provider: 'SINCH',
      providerNumberId: null,
      reason: 'Second assignment test',
      now
    });
    if (!secondNumber.ok) throw new Error('SECOND_NUMBER_SETUP_FAILED');
    await expect(repository.assignSmsNumber({
      actorUserId: ids.owner,
      numberId: secondNumber.value.id,
      organisationId: winner.value.organisationId,
      expectedStatus: 'AVAILABLE',
      expectedUpdatedAt: secondNumber.value.updatedAt,
      reason: 'Must reject a second active number',
      now
    })).resolves.toEqual({ ok: false, code: 'INVALID_STATE' });
  });

  it('requires verified provider evidence and retains inbound ownership through cooling', async () => {
    const organisationId = randomUUID();
    const now = new Date('2026-11-11T07:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `number-lifecycle-${organisationId}`,
      name: 'Number Lifecycle',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    const registered = await repository.registerSmsNumber({
      actorUserId: ids.owner,
      e164Number: phone(6),
      provider: 'SINCH',
      providerNumberId: null,
      reason: 'Lifecycle test',
      now
    });
    if (!registered.ok) throw new Error('NUMBER_SETUP_FAILED');
    const assigned = await repository.assignSmsNumber({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      organisationId,
      expectedStatus: 'AVAILABLE',
      expectedUpdatedAt: registered.value.updatedAt,
      reason: 'Allocate customer number',
      now
    });
    if (!assigned.ok) throw new Error('NUMBER_ASSIGNMENT_FAILED');

    await expect(repository.markSmsNumberReady({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      organisationId,
      expectedStatus: 'RESERVED',
      expectedUpdatedAt: assigned.value.updatedAt,
      providerNumberId: '',
      reason: 'Verified in Sinch',
      now
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    const ready = await repository.markSmsNumberReady({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      organisationId,
      expectedStatus: 'RESERVED',
      expectedUpdatedAt: assigned.value.updatedAt,
      providerNumberId: providerId('666'),
      reason: 'Verified in Sinch',
      now
    });
    expect(ready).toMatchObject({
      ok: true,
      value: { status: 'READY', providerVerifiedAt: now }
    });
    if (!ready.ok) throw new Error('NUMBER_READY_FAILED');

    await expect(repository.quarantineSmsNumber({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      expectedStatus: 'READY',
      expectedUpdatedAt: ready.value.updatedAt,
      quarantineUntil: new Date('2026-11-12T07:00:00.000Z'),
      reason: 'Cooling period too short',
      now
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });

    const released = await repository.releaseSmsNumber({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      expectedStatus: 'READY',
      expectedUpdatedAt: ready.value.updatedAt,
      reason: 'Customer subscription ended',
      now
    });
    expect(released).toMatchObject({
      ok: true,
      value: {
        status: 'QUARANTINED',
        organisationId,
        providerVerifiedAt: null,
        quarantineUntil: new Date('2026-12-11T07:00:00.000Z')
      }
    });
    if (!released.ok) throw new Error('NUMBER_RELEASE_FAILED');
    await expect(repository.returnSmsNumberToPool({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      expectedStatus: 'QUARANTINED',
      expectedUpdatedAt: released.value.updatedAt,
      reason: 'Attempt early return',
      now: new Date('2026-12-10T07:00:00.000Z')
    })).resolves.toEqual({ ok: false, code: 'INVALID_STATE' });
    await expect(repository.returnSmsNumberToPool({
      actorUserId: ids.owner,
      numberId: registered.value.id,
      expectedStatus: 'QUARANTINED',
      expectedUpdatedAt: released.value.updatedAt,
      reason: 'Cooling period complete',
      now: new Date('2026-12-11T07:00:00.000Z')
    })).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'AVAILABLE',
        organisationId: null,
        providerVerifiedAt: null
      }
    });
  });

  it('updates allowance limits without rewriting usage or overage settings', async () => {
    const organisationId = randomUUID();
    const now = new Date('2026-11-11T08:00:00.000Z');
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: `allowance-${organisationId}`,
      name: 'Allowance Customer',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'ACTIVE',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      lastStripeEventCreatedAt: now
    });
    await client.db.insert(smsAllowanceSettings).values({
      organisationId,
      includedParts: 2_000,
      warningPercent: 80,
      overageEnabled: true,
      overageCapCents: 5_000,
      overageCentsPerPart: 7
    });
    const originalSetting = await client.db.query.smsAllowanceSettings.findFirst({
      where: (table, { eq }) => eq(table.organisationId, organisationId)
    });
    if (!originalSetting) throw new Error('ALLOWANCE_SETUP_FAILED');
    await client.db.insert(smsUsageLedger).values([
      {
        organisationId,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        source: 'REMINDER',
        entryType: 'RESERVE',
        partDelta: 23,
        idempotencyKey: `allowance-reserve-${organisationId}`
      },
      {
        organisationId,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        source: 'REMINDER',
        entryType: 'COMMIT',
        partDelta: 23,
        idempotencyKey: `allowance-commit-${organisationId}`
      }
    ]);

    await expect(repository.updateSmsAllowance({
      actorUserId: ids.owner,
      organisationId,
      includedParts: 0,
      warningPercent: 101,
      expectedUpdatedAt: originalSetting.updatedAt,
      reason: 'Invalid limits',
      now
    })).resolves.toEqual({ ok: false, code: 'VALIDATION' });
    const updated = await repository.updateSmsAllowance({
      actorUserId: ids.owner,
      organisationId,
      includedParts: 3_000,
      warningPercent: 90,
      expectedUpdatedAt: originalSetting.updatedAt,
      reason: 'Approved higher allowance',
      now
    });
    const setting = await client.db.query.smsAllowanceSettings.findFirst({
      where: (table, { eq }) => eq(table.organisationId, organisationId)
    });
    const ledger = await client.db
      .select()
      .from(smsUsageLedger)
      .where(eq(smsUsageLedger.organisationId, organisationId));
    const audit = await repository.listAuditEvents({
      organisationId,
      eventType: 'SMS_ALLOWANCE_UPDATED'
    });

    expect(updated).toMatchObject({
      ok: true,
      value: {
        includedParts: 3_000,
        warningPercent: 90,
        committedParts: 23,
        reservedParts: 0
      }
    });
    expect(setting).toMatchObject({
      includedParts: 3_000,
      warningPercent: 90,
      overageEnabled: true,
      overageCapCents: 5_000,
      overageCentsPerPart: 7
    });
    expect(ledger).toHaveLength(2);
    expect(audit.items).toHaveLength(1);

    await expect(repository.updateSmsAllowance({
      actorUserId: ids.owner,
      organisationId,
      includedParts: 4_000,
      warningPercent: 95,
      expectedUpdatedAt: originalSetting.updatedAt,
      reason: 'Stale form must not overwrite the newer allowance',
      now: new Date(now.getTime() + 1_000)
    })).resolves.toEqual({ ok: false, code: 'CONFLICT' });
  });
});
