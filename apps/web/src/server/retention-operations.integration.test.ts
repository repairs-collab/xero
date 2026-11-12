import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  createDatabase,
  dataRequestCases,
  migrateDatabase,
  organisations,
  platformAdminAuditEvents,
  retentionCases,
  retentionOperationReceipts,
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
    const closureEpisodeId = randomUUID();
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
      closureEpisodeId,
      closureEffectiveAt: new Date('2021-08-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      backupExpiryVerifiedAt: new Date('2026-08-15T00:00:00.000Z'),
      backupExpiryEvidenceReference: 'backup-review-held-owner',
      backupExpiryClosureEpisodeId: closureEpisodeId
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
        operationId: 'cross-tenant-review-attempt',
        reason: 'Attempted cross-tenant review'
      })
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });

    const reviewInput = {
      organisationId,
      requestId,
      expectedVersion: 0,
      operationId: 'review-held-request-v0',
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
    await expect(
      service.reviewDataRequest(actorUserId, {
        ...reviewInput,
        operationId: 'different-review-of-stale-version'
      })
    ).resolves.toEqual({ ok: false, code: 'CONFLICT' });
    expect(
      await client.db
        .select()
        .from(retentionOperationReceipts)
        .where(eq(retentionOperationReceipts.organisationId, organisationId))
    ).toHaveLength(1);
  });

  it('refreshes backup-ageing evidence with tenant, retry and expected-state guards', async () => {
    const actorUserId = randomUUID();
    const organisationId = randomUUID();
    const closureEpisodeId = randomUUID();
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
      closureEpisodeId,
      closureEffectiveAt: new Date('2021-08-01T00:00:00.000Z'),
      deletionEligibleAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: expectedUpdatedAt
    });
    let actionNow = now;
    const service = createRetentionOperationsService({
      verifyOwner: () => Promise.resolve(true),
      repository: new PostgresRetentionOperationsRepository(client.db),
      clock: { now: () => actionNow }
    });
    const input = {
      organisationId,
      closureEpisodeId,
      verifiedAt: new Date('2026-09-17T05:00:00.000Z'),
      evidenceReference: 'ovh-backup-review-123',
      expectedUpdatedAt,
      operationId: 'backup-review-episode-v1',
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
      {
        ...input,
        operationId: 'different-backup-operation',
        evidenceReference: 'different-evidence'
      }
    );
    actionNow = new Date('2026-09-19T00:00:00.000Z');
    const refreshedInput = {
      ...input,
      verifiedAt: new Date('2026-09-18T12:00:00.000Z'),
      evidenceReference: 'ovh-backup-review-456',
      expectedUpdatedAt: now,
      operationId: 'backup-review-episode-at1789689600000',
      reason: 'Refreshed evidence for a later completed backup review'
    };
    const refreshed = await service.recordBackupExpiryVerification(
      actorUserId,
      refreshedInput
    );
    const refreshedRetry = await service.recordBackupExpiryVerification(
      actorUserId,
      refreshedInput
    );

    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      ok: true,
      value: {
        organisationId,
        backupExpiryVerifiedAt: new Date('2026-09-17T05:00:00.000Z'),
        backupExpiryEvidenceReference: 'ovh-backup-review-123',
        backupExpiryClosureEpisodeId: closureEpisodeId,
        updatedAt: now
      }
    });
    expect(conflict).toEqual({ ok: false, code: 'CONFLICT' });
    expect(refreshed).toEqual(refreshedRetry);
    expect(refreshed).toMatchObject({
      ok: true,
      value: {
        organisationId,
        backupExpiryVerifiedAt: new Date('2026-09-18T12:00:00.000Z'),
        backupExpiryEvidenceReference: 'ovh-backup-review-456',
        backupExpiryClosureEpisodeId: closureEpisodeId,
        updatedAt: actionNow
      }
    });
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
    ).toHaveLength(2);
  });

  it('completes an exported request once only after a request-bound backup audit', async () => {
    const actorUserId = randomUUID();
    const organisationId = randomUUID();
    const requestId = randomUUID();
    const exportAuditId = randomUUID();
    await client.db.insert(users).values({ id: actorUserId, cognitoSubject: randomUUID(), email: `${actorUserId}@example.invalid`, displayName: 'Export Owner' });
    await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Export completion tenant', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
    await client.db.insert(dataRequestCases).values({ id: requestId, organisationId, requestType: 'EXPORT', status: 'IN_REVIEW', verificationReference: 'privacy-export-complete', idempotencyKey: 'verified-export-complete', verifiedAt: new Date('2026-09-01T00:00:00.000Z'), targetAt: new Date('2026-09-15T00:00:00.000Z'), version: 1, lastReviewedAt: new Date('2026-09-15T00:00:00.000Z') });
    const service = createRetentionOperationsService({ verifyOwner: () => Promise.resolve(true), repository: new PostgresRetentionOperationsRepository(client.db), clock: { now: () => now } });
    const completion = { organisationId, requestId, expectedVersion: 1, operationId: 'complete-export-request-v1', deliveryReference: 'secure-delivery-123' };

    await expect(service.completeExportRequest(actorUserId, completion)).resolves.toEqual({ ok: false, code: 'CONFLICT' });
    await client.db.insert(platformAdminAuditEvents).values({ id: exportAuditId, actorUserId, targetOrganisationId: organisationId, eventType: 'PLATFORM_CUSTOMER_BACKUP_DOWNLOADED', entityType: 'DATA_REQUEST', entityId: requestId, reason: 'Owner delivered verified customer export', afterValue: { requestId }, occurredAt: new Date('2026-09-17T23:00:00.000Z') });

    const first = await service.completeExportRequest(actorUserId, completion);
    const retry = await service.completeExportRequest(actorUserId, completion);
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ ok: true, value: { id: requestId, status: 'COMPLETED', version: 2, completedAt: now, completedByUserId: actorUserId, completionReference: 'secure-delivery-123', completionExportAuditEventId: exportAuditId } });
    await expect(service.completeExportRequest(actorUserId, { ...completion, operationId: 'stale-second-completion' })).resolves.toEqual({ ok: false, code: 'CONFLICT' });
    expect(await client.db.select().from(auditEvents).where(and(eq(auditEvents.organisationId, organisationId), eq(auditEvents.eventType, 'DATA_REQUEST_EXPORT_COMPLETED'), eq(auditEvents.entityId, requestId)))).toHaveLength(1);
  });
});
