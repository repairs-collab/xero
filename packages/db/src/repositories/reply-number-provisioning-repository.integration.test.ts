import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  billingCases,
  organisations,
  smsNumberPool,
  subscriptions,
  users
} from '../schema/index.js';
import { PostgresReplyNumberProvisioningRepository } from './reply-number-provisioning-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const repository = new PostgresReplyNumberProvisioningRepository(client.db);
const now = new Date('2026-11-12T02:30:00.000Z');
const periodEnd = new Date('2026-12-12T00:00:00.000Z');
const ownerId = randomUUID();
const operatorId = randomUUID();

beforeAll(async () => {
  await migrateDatabase(client.db);
  await client.db.insert(users).values([
    {
      id: ownerId,
      cognitoSubject: `reply-owner-${ownerId}`,
      email: `reply-owner-${ownerId}@example.test`,
      displayName: 'Reply number owner',
      platformRole: 'OWNER'
    },
    {
      id: operatorId,
      cognitoSubject: `reply-operator-${operatorId}`,
      email: `reply-operator-${operatorId}@example.test`,
      displayName: 'Not an owner'
    }
  ]);
});
afterAll(() => client.pool.end());

const seedOrganisation = async (
  options: {
    status?: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCEL_AT_PERIOD_END' | 'CANCELLED';
    trustedStatus?: string | null;
    platformStatus?: 'ACTIVE' | 'SUSPENDED';
    currentPeriodEnd?: Date;
  } = {}
) => {
  const organisationId = randomUUID();
  const platformStatus = options.platformStatus ?? 'ACTIVE';
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: `reply-xero-${organisationId}`,
    name: `Reply number ${organisationId}`,
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO',
    platformStatus,
    suspendedAt: platformStatus === 'SUSPENDED' ? now : null,
    suspensionReason: platformStatus === 'SUSPENDED' ? 'Owner review' : null
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: options.status ?? 'ACTIVE',
    trustedStripeProviderStatus:
      options.trustedStatus === undefined ? 'active' : options.trustedStatus,
    currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
    currentPeriodEnd: options.currentPeriodEnd ?? periodEnd,
    cancelAt:
      options.status === 'CANCEL_AT_PERIOD_END'
        ? new Date('2026-12-10T00:00:00.000Z')
        : null
  });
  return organisationId;
};

const prepareQuotedRequest = async (organisationId: string) => {
  const ensured = await repository.ensureRequestForPaidOrganisation({
    organisationId,
    provider: 'SINCH',
    now
  });
  if (!ensured.ok) throw new Error(`ensure failed: ${ensured.code}`);
  const quoted = await repository.recordQuote({
    actorUserId: ownerId,
    organisationId,
    requestId: ensured.value.id,
    expectedVersion: ensured.value.version,
    setupFeeMinor: 1_135,
    monthlyFeeMinor: 1_530,
    currency: 'aud',
    quoteExpiresAt: new Date('2026-11-20T00:00:00.000Z'),
    documentationStatus: 'NOT_REQUIRED',
    documentationEvidenceReference: null,
    reason: 'Written Australian number quote received',
    now
  });
  if (!quoted.ok) throw new Error(`quote failed: ${quoted.code}`);
  return quoted.value;
};

const approveRequest = async (organisationId: string) => {
  const request = await prepareQuotedRequest(organisationId);
  const approved = await repository.approveManualOrder({
    actorUserId: ownerId,
    organisationId,
    requestId: request.id,
    expectedVersion: request.version,
    confirmedSetupFeeMinor: 1_135,
    confirmedMonthlyFeeMinor: 1_530,
    reason: 'Approved exact written quote for one number',
    now
  });
  if (!approved.ok) throw new Error(`approval failed: ${approved.code}`);
  return approved.value;
};

const recordExternalOrder = async (organisationId: string) => {
  const request = await approveRequest(organisationId);
  const ordered = await repository.recordManualOrderReference({
    actorUserId: ownerId,
    organisationId,
    requestId: request.id,
    expectedVersion: request.version,
    externalOrderReference: `AU-ORDER-${randomUUID()}`,
    reason: 'Order placed in the provider portal',
    now
  });
  if (!ordered.ok) throw new Error(`order reference failed: ${ordered.code}`);
  return ordered.value;
};

describe('PostgresReplyNumberProvisioningRepository', () => {
  it('distinguishes no request from an existing active manual request', async () => {
    const organisationId = await seedOrganisation();

    await expect(
      repository.loadOrganisationProvisioningState(organisationId)
    ).resolves.toEqual({ kind: 'NONE' });

    const ensured = await repository.ensureRequestForPaidOrganisation({
      organisationId,
      provider: 'SINCH',
      now
    });
    if (!ensured.ok) throw new Error(`ensure failed: ${ensured.code}`);

    await expect(
      repository.loadOrganisationProvisioningState(organisationId)
    ).resolves.toEqual({
      kind: 'ACTIVE_REQUEST',
      requestId: ensured.value.id,
      status: 'AWAITING_QUOTE'
    });
  });

  it.each([
    ['RESERVED', 'ASSIGNED_RESERVED'],
    ['READY', 'ASSIGNED_READY'],
    ['QUARANTINED', 'ASSIGNED_QUARANTINED']
  ] as const)(
    'reports an assigned %s number without claiming another number',
    async (status, kind) => {
      const organisationId = await seedOrganisation();
      const [number] = await client.db
        .insert(smsNumberPool)
        .values({
          e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
          provider: 'SINCH',
          providerNumberId: `sinch-${randomUUID()}`,
          providerVerifiedAt:
            status === 'RESERVED'
              ? null
              : new Date('2026-11-12T02:00:00.000Z'),
          status,
          organisationId,
          reservedAt: now,
          readyAt: status === 'READY' ? now : null,
          quarantineUntil:
            status === 'QUARANTINED'
              ? new Date('2026-12-12T02:30:00.000Z')
              : null
        })
        .returning({
          id: smsNumberPool.id,
          e164Number: smsNumberPool.e164Number
        });
      if (!number) throw new Error('number insert failed');

      await expect(
        repository.loadOrganisationProvisioningState(organisationId)
      ).resolves.toEqual({
        kind,
        numberId: number.id,
        e164Number: number.e164Number
      });
    }
  );

  it('creates one idempotent request during concurrent paid provisioning', async () => {
    const organisationId = await seedOrganisation();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.ensureRequestForPaidOrganisation({
          organisationId,
          provider: 'SINCH',
          now
        })
      )
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const ids = results.flatMap((result) => (result.ok ? [result.value.id] : []));
    expect(new Set(ids).size).toBe(1);
    await expect(
      client.db.query.replyNumberProvisioningRequests.findMany({
        where: (table, { eq }) => eq(table.organisationId, organisationId)
      })
    ).resolves.toHaveLength(1);
  });

  it.each([
    ['TRIALING', 'trialing'],
    ['ACTIVE', 'past_due'],
    ['PAST_DUE', 'past_due'],
    ['CANCELLED', 'canceled']
  ] as const)('does not create a request for %s subscriptions', async (status, trustedStatus) => {
    const organisationId = await seedOrganisation({ status, trustedStatus });

    await expect(
      repository.ensureRequestForPaidOrganisation({
        organisationId,
        provider: 'SINCH',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'NOT_ELIGIBLE' });
  });

  it('allows a scheduled cancellation draft but blocks owner approval', async () => {
    const organisationId = await seedOrganisation({
      status: 'CANCEL_AT_PERIOD_END',
      trustedStatus: 'active'
    });
    const request = await prepareQuotedRequest(organisationId);

    await expect(
      repository.approveManualOrder({
        actorUserId: ownerId,
        organisationId,
        requestId: request.id,
        expectedVersion: request.version,
        confirmedSetupFeeMinor: 1_135,
        confirmedMonthlyFeeMinor: 1_530,
        reason: 'Should not authorise recurring cost',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'NOT_ELIGIBLE' });
  });

  it('rejects cross-organisation, stale-version and non-owner mutations', async () => {
    const organisationId = await seedOrganisation();
    const otherOrganisationId = await seedOrganisation();
    const ensured = await repository.ensureRequestForPaidOrganisation({
      organisationId,
      provider: 'SINCH',
      now
    });
    if (!ensured.ok) throw new Error('request missing');
    const base = {
      organisationId,
      requestId: ensured.value.id,
      expectedVersion: ensured.value.version,
      setupFeeMinor: 1_135,
      monthlyFeeMinor: 1_530,
      currency: 'aud' as const,
      quoteExpiresAt: new Date('2026-11-20T00:00:00.000Z'),
      documentationStatus: 'NOT_REQUIRED' as const,
      documentationEvidenceReference: null,
      reason: 'Quote',
      now
    };

    await expect(
      repository.recordQuote({
        ...base,
        actorUserId: ownerId,
        organisationId: otherOrganisationId
      })
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    await expect(
      repository.recordQuote({
        ...base,
        actorUserId: ownerId,
        expectedVersion: 999
      })
    ).resolves.toEqual({ ok: false, code: 'CONFLICT' });
    await expect(
      repository.recordQuote({ ...base, actorUserId: operatorId })
    ).resolves.toEqual({ ok: false, code: 'NOT_OWNER' });
  });

  it('requires an unexpired exact quote and rejects a financial-risk hold', async () => {
    const expiredOrganisationId = await seedOrganisation();
    const ensured = await repository.ensureRequestForPaidOrganisation({
      organisationId: expiredOrganisationId,
      provider: 'SINCH',
      now
    });
    if (!ensured.ok) throw new Error('request missing');
    const quote = await repository.recordQuote({
      actorUserId: ownerId,
      organisationId: expiredOrganisationId,
      requestId: ensured.value.id,
      expectedVersion: ensured.value.version,
      setupFeeMinor: 1_135,
      monthlyFeeMinor: 1_530,
      currency: 'aud',
      quoteExpiresAt: new Date('2026-11-12T02:31:00.000Z'),
      documentationStatus: 'NOT_REQUIRED',
      documentationEvidenceReference: null,
      reason: 'Short quote',
      now
    });
    if (!quote.ok) throw new Error('quote failed');

    await expect(
      repository.approveManualOrder({
        actorUserId: ownerId,
        organisationId: expiredOrganisationId,
        requestId: quote.value.id,
        expectedVersion: quote.value.version,
        confirmedSetupFeeMinor: 1_135,
        confirmedMonthlyFeeMinor: 1_530,
        reason: 'Expired confirmation',
        now: new Date('2026-11-12T02:32:00.000Z')
      })
    ).resolves.toEqual({ ok: false, code: 'QUOTE_EXPIRED' });

    const riskOrganisationId = await seedOrganisation();
    const riskRequest = await prepareQuotedRequest(riskOrganisationId);
    await client.db.insert(billingCases).values({
      organisationId: riskOrganisationId,
      kind: 'DISPUTE',
      status: 'OPEN',
      providerObjectType: 'DISPUTE',
      providerObjectId: `dp_${randomUUID()}`,
      providerStatus: 'needs_response',
      stripeSubscriptionId: `sub_${randomUUID()}`,
      subscriptionRelation: 'CURRENT',
      amountMinor: 5_000,
      currency: 'aud',
      blocksSending: true,
      latestProviderEventId: `evt_${randomUUID()}`,
      latestProviderEventCreatedAt: now,
      openedAt: now
    });

    await expect(
      repository.approveManualOrder({
        actorUserId: ownerId,
        organisationId: riskOrganisationId,
        requestId: riskRequest.id,
        expectedVersion: riskRequest.version,
        confirmedSetupFeeMinor: 1_135,
        confirmedMonthlyFeeMinor: 1_530,
        reason: 'Risk must block',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'BILLING_RISK_HOLD' });
  });

  it('requires the owner to confirm the exact written quote', async () => {
    const organisationId = await seedOrganisation();
    const request = await prepareQuotedRequest(organisationId);

    await expect(
      repository.approveManualOrder({
        actorUserId: ownerId,
        organisationId,
        requestId: request.id,
        expectedVersion: request.version,
        confirmedSetupFeeMinor: 1_135,
        confirmedMonthlyFeeMinor: 1_531,
        reason: 'Incorrect monthly amount',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'AMOUNT_MISMATCH' });
  });

  it('blocks a manual order until required documentation has a redacted completion reference', async () => {
    const organisationId = await seedOrganisation();
    const ensured = await repository.ensureRequestForPaidOrganisation({
      organisationId,
      provider: 'SINCH',
      now
    });
    if (!ensured.ok) throw new Error('request missing');
    const quoted = await repository.recordQuote({
      actorUserId: ownerId,
      organisationId,
      requestId: ensured.value.id,
      expectedVersion: ensured.value.version,
      setupFeeMinor: 1_135,
      monthlyFeeMinor: 1_530,
      currency: 'aud',
      quoteExpiresAt: new Date('2026-11-20T00:00:00.000Z'),
      documentationStatus: 'REQUIRED',
      documentationEvidenceReference: null,
      reason: 'Provider requires evidence before ordering',
      now
    });
    if (!quoted.ok) throw new Error('quote missing');
    const approved = await repository.approveManualOrder({
      actorUserId: ownerId,
      organisationId,
      requestId: quoted.value.id,
      expectedVersion: quoted.value.version,
      confirmedSetupFeeMinor: 1_135,
      confirmedMonthlyFeeMinor: 1_530,
      reason: 'Approve the exact quote without placing an order',
      now
    });
    if (!approved.ok) throw new Error('approval missing');
    const orderInput = {
      actorUserId: ownerId,
      organisationId,
      requestId: approved.value.id,
      expectedVersion: approved.value.version,
      externalOrderReference: `AU-ORDER-${randomUUID()}`,
      reason: 'Manual order after documentation completion',
      now
    };

    await expect(repository.recordManualOrderReference(orderInput)).resolves.toEqual({
      ok: false,
      code: 'INVALID_STATE'
    });
    const completed = await repository.recordDocumentationComplete({
      actorUserId: ownerId,
      organisationId,
      requestId: approved.value.id,
      expectedVersion: approved.value.version,
      documentationEvidenceReference: `case-${randomUUID()}`,
      reason: 'Required evidence reviewed outside AccountPulse',
      now
    });
    if (!completed.ok) throw new Error('documentation not completed');
    await expect(
      repository.recordManualOrderReference({
        ...orderInput,
        expectedVersion: completed.value.version
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { status: 'MANUAL_ORDER_RECORDED' }
    });
  });

  it('fulfils directly into an assigned RESERVED number and rejects collisions', async () => {
    const organisationId = await seedOrganisation();
    const ordered = await recordExternalOrder(organisationId);
    const suffix = randomInt(10_000_000, 99_999_999);
    const e164Number = `+614${suffix}`;
    const providerNumberId = `sinch-${randomUUID()}`;

    const fulfilled = await repository.recordFulfilledNumber({
      actorUserId: ownerId,
      organisationId,
      requestId: ordered.id,
      expectedVersion: ordered.version,
      e164Number,
      providerNumberId,
      reason: 'Provider supplied the ordered number',
      now
    });

    expect(fulfilled.ok).toBe(true);
    if (!fulfilled.ok) throw new Error('fulfilment failed');
    expect(fulfilled.value.status).toBe('FULFILLED');
    expect(typeof fulfilled.value.fulfilledNumberId).toBe('string');
    await expect(
      client.db.query.smsNumberPool.findFirst({
        where: (table, { eq }) => eq(table.e164Number, e164Number)
      })
    ).resolves.toMatchObject({
      organisationId,
      provider: 'SINCH',
      providerNumberId,
      providerVerifiedAt: null,
      status: 'RESERVED'
    });

    const collisionOrganisationId = await seedOrganisation();
    const collisionOrder = await recordExternalOrder(collisionOrganisationId);
    await expect(
      repository.recordFulfilledNumber({
        actorUserId: ownerId,
        organisationId: collisionOrganisationId,
        requestId: collisionOrder.id,
        expectedVersion: collisionOrder.version,
        e164Number,
        providerNumberId: `sinch-${randomUUID()}`,
        reason: 'Duplicate number',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'NUMBER_CONFLICT' });

    await expect(
      repository.recordFulfilledNumber({
        actorUserId: ownerId,
        organisationId: collisionOrganisationId,
        requestId: collisionOrder.id,
        expectedVersion: collisionOrder.version,
        e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
        providerNumberId,
        reason: 'Duplicate provider number ID',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'NUMBER_CONFLICT' });
  });

  it('enforces unique request keys and one active request per organisation in PostgreSQL', async () => {
    const organisationId = await seedOrganisation();
    const otherOrganisationId = await seedOrganisation();
    const ensured = await repository.ensureRequestForPaidOrganisation({
      organisationId,
      provider: 'SINCH',
      now
    });
    if (!ensured.ok) throw new Error('request missing');

    await expect(
      client.pool.query(
        `insert into reply_number_provisioning_requests
          (organisation_id, provider, request_key, attempt, version, status)
         values ($1, 'SINCH', $2, 1, 1, 'AWAITING_QUOTE')`,
        [otherOrganisationId, ensured.value.requestKey]
      )
    ).rejects.toThrow();
    await expect(
      client.pool.query(
        `insert into reply_number_provisioning_requests
          (organisation_id, provider, request_key, attempt, version, status)
         values ($1, 'SINCH', $2, 2, 1, 'AWAITING_QUOTE')`,
        [organisationId, `second-active-${randomUUID()}`]
      )
    ).rejects.toThrow();
  });

  it('starts a new attempt only after an expired request is terminal', async () => {
    const organisationId = await seedOrganisation();
    const ensured = await repository.ensureRequestForPaidOrganisation({
      organisationId,
      provider: 'SINCH',
      now
    });
    if (!ensured.ok) throw new Error('request missing');
    const quoted = await repository.recordQuote({
      actorUserId: ownerId,
      organisationId,
      requestId: ensured.value.id,
      expectedVersion: ensured.value.version,
      setupFeeMinor: 1_135,
      monthlyFeeMinor: 1_530,
      currency: 'aud',
      quoteExpiresAt: new Date('2026-11-12T02:31:00.000Z'),
      documentationStatus: 'NOT_REQUIRED',
      documentationEvidenceReference: null,
      reason: 'Short-lived written quote',
      now
    });
    if (!quoted.ok) throw new Error('quote missing');
    const retryTime = new Date('2026-11-12T02:32:00.000Z');
    await expect(
      repository.expireRequest({
        actorUserId: ownerId,
        organisationId,
        requestId: quoted.value.id,
        expectedVersion: quoted.value.version,
        reason: 'Written quote expired before approval',
        now: retryTime
      })
    ).resolves.toMatchObject({ ok: true, value: { status: 'EXPIRED' } });

    await expect(
      repository.ensureRequestForPaidOrganisation({
        organisationId,
        provider: 'SINCH',
        now: retryTime
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { attempt: 2, status: 'AWAITING_QUOTE' }
    });
  });

  it('records only a redacted failure code before allowing a retry', async () => {
    const organisationId = await seedOrganisation();
    const ensured = await repository.ensureRequestForPaidOrganisation({
      organisationId,
      provider: 'SINCH',
      now
    });
    if (!ensured.ok) throw new Error('request missing');
    await expect(
      repository.failRequest({
        actorUserId: ownerId,
        organisationId,
        requestId: ensured.value.id,
        expectedVersion: ensured.value.version,
        failureCode: 'PROVIDER_MANUAL_REVIEW',
        reason: 'Owner recorded a provider-neutral failure category',
        now
      })
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'FAILED',
        failureCode: 'PROVIDER_MANUAL_REVIEW',
        attempt: 1
      }
    });
    await expect(
      repository.ensureRequestForPaidOrganisation({
        organisationId,
        provider: 'SINCH',
        now
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { attempt: 2, status: 'AWAITING_QUOTE' }
    });
  });

  it('does not fulfil when the organisation already has an active number', async () => {
    const organisationId = await seedOrganisation();
    const ordered = await recordExternalOrder(organisationId);
    await client.db.insert(smsNumberPool).values({
      e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
      provider: 'SINCH',
      providerNumberId: `sinch-${randomUUID()}`,
      status: 'RESERVED',
      organisationId,
      reservedAt: now
    });

    await expect(
      repository.recordFulfilledNumber({
        actorUserId: ownerId,
        organisationId,
        requestId: ordered.id,
        expectedVersion: ordered.version,
        e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
        providerNumberId: `sinch-${randomUUID()}`,
        reason: 'Second number should be blocked',
        now
      })
    ).resolves.toEqual({ ok: false, code: 'NUMBER_CONFLICT' });
  });

  it('enforces state bundles and cross-tenant fulfilled-number ownership in PostgreSQL', async () => {
    const organisationId = await seedOrganisation();
    await expect(
      client.pool.query(
        `insert into reply_number_provisioning_requests
          (organisation_id, provider, request_key, attempt, version, status,
           quote_setup_fee_minor, quote_monthly_fee_minor, quote_currency)
         values ($1, 'SINCH', $2, 1, 1, 'AWAITING_OWNER_APPROVAL', 1, 1, 'aud')`,
        [organisationId, `invalid-${randomUUID()}`]
      )
    ).rejects.toThrow();

    const otherOrganisationId = await seedOrganisation();
    const [foreignNumber] = await client.db
      .insert(smsNumberPool)
      .values({
        e164Number: `+614${randomInt(10_000_000, 99_999_999)}`,
        provider: 'SINCH',
        providerNumberId: `sinch-${randomUUID()}`,
        status: 'RESERVED',
        organisationId: otherOrganisationId,
        reservedAt: now
      })
      .returning({ id: smsNumberPool.id });
    expect(foreignNumber).toBeDefined();
    await expect(
      client.pool.query(
        `insert into reply_number_provisioning_requests
          (organisation_id, provider, request_key, attempt, version, status,
           quote_setup_fee_minor, quote_monthly_fee_minor, quote_currency,
           quote_expires_at, quoted_at, documentation_status,
           approved_by_user_id, approved_at, approval_reason,
           external_order_reference, manual_order_recorded_at,
           fulfilled_number_id)
         values ($1, 'SINCH', $2, 1, 1, 'FULFILLED', 1, 1, 'aud',
                 $3, $4, 'NOT_REQUIRED', $5, $4, 'Approved',
                 'AU-ORDER-TEST', $4, $6)`,
        [
          organisationId,
          `foreign-${randomUUID()}`,
          new Date('2026-11-20T00:00:00.000Z'),
          now,
          ownerId,
          foreignNumber!.id
        ]
      )
    ).rejects.toThrow();
  });
});
