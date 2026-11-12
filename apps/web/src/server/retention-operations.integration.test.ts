import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  createDatabase,
  dataRequestCases,
  migrateDatabase,
  organisations,
  retentionCases,
  users
} from '@bc5000/db';

import {
  createRetentionOperationsService,
  PostgresRetentionOperationsRepository
} from './retention-operations.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-18T00:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('retention owner repository', () => {
  it('records a verified request once and rejects conflicting reuse of its tenant idempotency key', async () => {
    const actorUserId = randomUUID();
    const organisationId = randomUUID();
    await client.db.insert(users).values({
      id: actorUserId,
      cognitoSubject: randomUUID(),
      email: `${actorUserId}@example.invalid`,
      displayName: 'Privacy Officer'
    });
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Verified request tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    const service = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(true),
      repository: new PostgresRetentionOperationsRepository(client.db),
      clock: { now: () => now }
    });
    const input = {
      organisationId,
      requestType: 'DELETION' as const,
      verificationReference: 'privacy-case-idempotent',
      idempotencyKey: 'verified-request-idempotent',
      verifiedAt: new Date('2026-09-17T09:30:00.000Z')
    };

    const first = await service.recordVerifiedRequest(actorUserId, input);
    const retry = await service.recordVerifiedRequest(actorUserId, input);
    const conflict = await service.recordVerifiedRequest(actorUserId, {
      ...input,
      requestType: 'EXPORT'
    });

    expect(first).toEqual(retry);
    expect(first).toMatchObject({ ok: true });
    expect(conflict).toEqual({ ok: false, code: 'CONFLICT' });
    expect(
      await client.db
        .select()
        .from(dataRequestCases)
        .where(eq(dataRequestCases.organisationId, organisationId))
    ).toEqual([
      expect.objectContaining({
        requestType: 'DELETION',
        verifiedAt: new Date('2026-09-17T09:30:00.000Z'),
        targetAt: new Date('2026-10-01T09:30:00.000Z'),
        version: 0
      })
    ]);
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, organisationId),
            eq(auditEvents.eventType, 'DATA_REQUEST_VERIFIED')
          )
        )
    ).toHaveLength(1);
  });

  it('gives legal hold precedence with tenant-scoped and idempotent owner review', async () => {
    const actorUserId = randomUUID();
    const organisationId = randomUUID();
    const otherOrganisationId = randomUUID();
    await client.db.insert(users).values({
      id: actorUserId,
      cognitoSubject: randomUUID(),
      email: `${actorUserId}@example.invalid`,
      displayName: 'Retention Reviewer'
    });
    for (const [id, name] of [
      [organisationId, 'Held owner review tenant'],
      [otherOrganisationId, 'Other owner review tenant']
    ] as const) {
      await client.db.insert(organisations).values({
        id,
        xeroOrganisationId: randomUUID(),
        name,
        timeZone: 'Australia/Sydney',
        baseCurrency: 'AUD'
      });
    }
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'LEGAL_HOLD',
      disconnectedAt: new Date('2021-08-01T00:00:00.000Z'),
      reviewAfter: new Date('2021-09-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      backupExpiryVerifiedAt: new Date('2026-08-15T00:00:00.000Z'),
      backupExpiryEvidenceReference: 'backup-review-held-owner'
    });
    const repository = new PostgresRetentionOperationsRepository(client.db);
    const service = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(true),
      repository,
      clock: { now: () => now }
    });
    const created = await service.recordVerifiedRequest(actorUserId, {
      organisationId,
      requestType: 'DELETION',
      verificationReference: 'privacy-case-held-owner',
      idempotencyKey: 'verified-request-held-owner',
      verifiedAt: new Date('2026-09-17T09:30:00.000Z')
    });
    const requestId = (created.value as { id: string }).id;

    await expect(
      service.reviewDataRequest(actorUserId, {
        organisationId: otherOrganisationId,
        requestId,
        expectedVersion: 0,
        reason: 'Attempted cross-tenant review'
      })
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });

    const reviewInput = {
      organisationId,
      requestId,
      expectedVersion: 0,
      reason: 'Legal hold must block deletion'
    };
    const firstReview = await service.reviewDataRequest(
      actorUserId,
      reviewInput
    );
    const retry = await service.reviewDataRequest(actorUserId, reviewInput);

    expect(firstReview).toEqual(retry);
    expect(firstReview).toMatchObject({
      ok: true,
      value: {
        id: requestId,
        organisationId,
        status: 'BLOCKED',
        blockReason: 'LEGAL_HOLD',
        version: 1
      }
    });
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, organisationId),
            eq(auditEvents.eventType, 'DATA_REQUEST_OWNER_REVIEWED'),
            eq(auditEvents.entityId, requestId)
          )
        )
    ).toHaveLength(1);
  });

  it('records backup-ageing evidence once with tenant and expected-state guards', async () => {
    const actorUserId = randomUUID();
    const organisationId = randomUUID();
    const expectedUpdatedAt = new Date('2026-09-16T00:00:00.000Z');
    await client.db.insert(users).values({
      id: actorUserId,
      cognitoSubject: randomUUID(),
      email: `${actorUserId}@example.invalid`,
      displayName: 'Backup Reviewer'
    });
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Backup evidence tenant',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(retentionCases).values({
      organisationId,
      source: 'SUBSCRIPTION_CANCELLED',
      status: 'REVIEW_REQUIRED',
      disconnectedAt: new Date('2021-08-01T00:00:00.000Z'),
      reviewAfter: new Date('2021-09-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: expectedUpdatedAt
    });
    const service = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(true),
      repository: new PostgresRetentionOperationsRepository(client.db),
      clock: { now: () => now }
    });
    const input = {
      organisationId,
      verifiedAt: new Date('2026-09-17T05:00:00.000Z'),
      evidenceReference: 'ovh-backup-review-123',
      expectedUpdatedAt,
      reason: 'Verified approved backup tiers have aged out'
    };

    const first = await service.recordBackupExpiryVerification(
      actorUserId,
      input
    );
    const retry = await service.recordBackupExpiryVerification(
      actorUserId,
      input
    );
    const conflict = await service.recordBackupExpiryVerification(
      actorUserId,
      { ...input, evidenceReference: 'different-evidence' }
    );

    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      ok: true,
      value: {
        organisationId,
        backupExpiryVerifiedAt: new Date('2026-09-17T05:00:00.000Z'),
        backupExpiryEvidenceReference: 'ovh-backup-review-123',
        updatedAt: now
      }
    });
    expect(conflict).toEqual({ ok: false, code: 'CONFLICT' });
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, organisationId),
            eq(auditEvents.eventType, 'BACKUP_AGEING_VERIFIED')
          )
        )
    ).toHaveLength(1);
  });
});
