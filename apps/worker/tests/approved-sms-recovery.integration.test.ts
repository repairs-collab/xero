import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  approvals,
  auditEvents,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  organisations,
  outboundMessages,
  reminderSequences,
  reminderSequenceVersions,
  reminderWhitelistEntries,
  sequenceStages,
  stageInstances,
  users
} from '@bc5000/db';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

import { renderReminderPreview } from '../src/handlers/reminders-calculate.js';
import {
  approvedSmsRecoveryAcknowledgement,
  createApprovedSmsRecoveryService
} from '../src/operations/approved-sms-recovery.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const database = createDatabase(databaseUrl);
const now = new Date('2026-09-30T03:30:00.000Z');

afterAll(async () => {
  await database.pool.end();
});

interface SeededStage {
  approvalId: string;
  regeneratedApprovalId: string;
  invoiceId: string;
  organisationId: string;
  stageInstanceId: string;
}

async function seedCancelledStage(options: {
  organisationId?: string;
  decidedAt?: Date | null;
  origin?: 'AUTOMATION' | 'MANUAL_REMINDER' | 'ESCALATION_SMS';
  previewMatches?: boolean;
  withApprovalAudit?: boolean;
  withWhitelist?: boolean;
  withOutbound?: boolean;
} = {}): Promise<SeededStage> {
  const organisationId = options.organisationId ?? randomUUID();
  const adminId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const invoiceChaseId = randomUUID();
  const stageInstanceId = randomUUID();
  const approvalId = randomUUID();
  const regeneratedApprovalId = randomUUID();
  const invoiceNumber = `REC-${invoiceId}`;
  const template =
    'Hi {{customer_name}}, invoice {{invoice_number}} for {{currency}} {{amount_due}} was due {{due_date}}. {{online_invoice_url}}';
  const decidedAt =
    options.decidedAt === undefined
      ? new Date('2026-09-30T00:00:00.000Z')
      : options.decidedAt;
  const approvedPreview = renderReminderPreview({
    channel: 'SMS',
    template,
    customerName: 'Recovery customer',
    invoiceNumber,
    amountDue: '125.5000',
    currency: 'AUD',
    dueDate: '2026-08-31',
    onlineInvoiceUrl: `https://pay.example.invalid/${invoiceId}`,
    organisationName: 'Approved SMS recovery test',
    maxSmsSegments: 3
  });

  if (options.organisationId === undefined) {
    await database.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Approved SMS recovery test',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      sendMode: 'live',
      rolloutScope: 'CUSTOMER',
      liveSendAcknowledged: true
    });
  }
  await database.db.insert(users).values({
    id: adminId,
    cognitoSubject: randomUUID(),
    email: `${adminId}@example.invalid`,
    displayName: 'Recovery approver'
  });
  await database.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Recovery customer'
  });
  await database.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber,
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '125.5000',
    currency: 'AUD',
    onlineInvoiceUrl: `https://pay.example.invalid/${invoiceId}`,
    syncVersion: 4
  });
  await database.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Recovery sequence ${sequenceId}`,
    mode: 'REVIEW'
  });
  await database.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    maxSmsSegments: 3
  });
  await database.db.insert(sequenceStages).values({
    organisationId,
    sequenceVersionId,
    stageKey: 'seven-days',
    offsetDays: 7,
    channel: 'SMS',
    template
  });
  await database.db.insert(invoiceChases).values({
    id: invoiceChaseId,
    organisationId,
    invoiceId,
    sequenceId,
    customerId: contactId,
    status: 'ACTIVE'
  });
  await database.db.insert(stageInstances).values({
    id: stageInstanceId,
    organisationId,
    invoiceChaseId,
    sequenceVersionId,
    stageKey: 'seven-days',
    origin: options.origin ?? 'AUTOMATION',
    channel: 'SMS',
    status: 'CANCELLED',
    scheduledAt: new Date('2026-09-30T00:00:00.000Z'),
    sourceVersion: 4,
    completedAt: new Date('2026-09-30T00:05:00.000Z')
  });
  await database.db.insert(approvals).values({
    id: approvalId,
    organisationId,
    stageInstanceId,
    renderedPreview:
      options.previewMatches === false
        ? 'The approved content no longer matches'
        : approvedPreview,
    sourceVersion: 3,
    status: 'EXPIRED',
    decidedByUserId: decidedAt === null ? null : adminId,
    decidedAt,
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-30T00:00:00.000Z')
  });
  await database.db.insert(approvals).values({
    id: regeneratedApprovalId,
    organisationId,
    stageInstanceId,
    renderedPreview: 'Regenerated approval retired by the scheduler',
    sourceVersion: 4,
    status: 'EXPIRED',
    expiresAt: new Date('2026-10-01T03:00:00.000Z'),
    createdAt: new Date('2026-09-30T03:00:00.000Z')
  });
  if (decidedAt !== null && options.withApprovalAudit !== false) {
    await database.db.insert(auditEvents).values({
      organisationId,
      actorUserId: adminId,
      eventType: 'REMINDER_APPROVED',
      entityType: 'APPROVAL',
      entityId: approvalId,
      beforeValue: { status: 'PENDING' },
      afterValue: { status: 'APPROVED' },
      occurredAt: decidedAt
    });
  }
  if (options.withWhitelist === true) {
    await database.db.insert(reminderWhitelistEntries).values({
      organisationId,
      scope: 'INVOICE',
      contactId,
      invoiceId,
      createdByUserId: adminId,
      reason: 'Recovery must preserve whitelist exclusions'
    });
  }
  if (options.withOutbound === true) {
    await database.db.insert(outboundMessages).values({
      organisationId,
      stageInstanceId,
      contactId,
      invoiceId,
      channel: 'SMS',
      source: 'AUTOMATED_REMINDER',
      recipientKey: '+61400000001',
      idempotencyKey: `existing:${stageInstanceId}`,
      status: 'ACCEPTED'
    });
  }

  return {
    approvalId,
    regeneratedApprovalId,
    invoiceId,
    organisationId,
    stageInstanceId
  };
}

const publisher = (): JobPublisher => ({
  publish: vi.fn(() => Promise.resolve(randomUUID()))
});

describe('approved SMS recovery', () => {
  it('queues only today\'s approved, unsent automation SMS despite a later undecided expiry', async () => {
    const eligible = await seedCancelledStage();
    await seedCancelledStage({
      organisationId: eligible.organisationId,
      decidedAt: new Date('2026-09-29T03:00:00.000Z')
    });
    await seedCancelledStage({
      organisationId: eligible.organisationId,
      decidedAt: null
    });
    await seedCancelledStage({
      organisationId: eligible.organisationId,
      origin: 'MANUAL_REMINDER'
    });
    await seedCancelledStage({
      organisationId: eligible.organisationId,
      withOutbound: true
    });
    await seedCancelledStage({
      organisationId: eligible.organisationId,
      withWhitelist: true
    });
    await seedCancelledStage({
      organisationId: eligible.organisationId,
      previewMatches: false
    });
    await seedCancelledStage({
      organisationId: eligible.organisationId,
      withApprovalAudit: false
    });

    const publish: JobPublisher['publish'] = vi.fn(() =>
      Promise.resolve(randomUUID())
    );
    const recovery = createApprovedSmsRecoveryService({
      database: database.db,
      clock: { now: () => now },
      publisher: { publish }
    });

    const preview = await recovery.preview({
      organisationId: eligible.organisationId,
      localDate: '2026-09-30'
    });
    expect(preview).toMatchObject({
      localDate: '2026-09-30',
      count: 1,
      stageInstanceIds: [eligible.stageInstanceId]
    });
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      recovery.execute({
        organisationId: eligible.organisationId,
        localDate: '2026-09-30',
        expectedCount: 2,
        expectedDigest: preview.digest,
        acknowledgement: approvedSmsRecoveryAcknowledgement('2026-09-30')
      })
    ).rejects.toThrow('RECOVERY_COUNT_CHANGED');

    const result = await recovery.execute({
      organisationId: eligible.organisationId,
      localDate: '2026-09-30',
      expectedCount: 1,
      expectedDigest: preview.digest,
      acknowledgement: approvedSmsRecoveryAcknowledgement('2026-09-30')
    });
    expect(result).toEqual({
      candidateCount: 1,
      publishedCount: 1,
      failedCount: 0,
      uncertainCount: 0
    });
    expect(publish).toHaveBeenCalledWith(
      jobNames.reminderExecute,
      {
        organisationId: eligible.organisationId,
        stageInstanceId: eligible.stageInstanceId
      },
      {
        singletonKey: `approved-sms-recovery:2026-09-30:${eligible.stageInstanceId}:4`
      }
    );

    const [stage] = await database.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, eligible.stageInstanceId));
    const stageApprovals = await database.db
      .select()
      .from(approvals)
      .where(eq(approvals.stageInstanceId, eligible.stageInstanceId));
    const originalApproval = stageApprovals.find(
      (approval) => approval.id === eligible.approvalId
    );
    const queuedApproval = stageApprovals.find(
      (approval) =>
        approval.id !== eligible.approvalId &&
        approval.id !== eligible.regeneratedApprovalId
    );
    expect(stage?.status).toBe('QUEUED');
    expect(stage?.sourceVersion).toBe(4);
    expect(stage?.completedAt).toBeNull();
    expect(originalApproval?.status).toBe('EXPIRED');
    expect(queuedApproval).toMatchObject({
      sourceVersion: 4,
      status: 'APPROVED',
      decidedAt: now,
      expiresAt: new Date('2026-10-01T03:30:00.000Z')
    });
    expect(queuedApproval?.decidedByUserId).not.toBeNull();
    expect(queuedApproval?.renderedPreview).toContain(
      'Recovery customer'
    );
    expect(queuedApproval?.renderedPreview).toContain(
      `https://pay.example.invalid/${eligible.invoiceId}`
    );

    const events = await database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, eligible.organisationId),
          eq(auditEvents.eventType, 'APPROVED_SMS_RECOVERY_QUEUED')
        )
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe(eligible.stageInstanceId);
  });

  it('makes no changes when the reviewed candidate digest has changed', async () => {
    const eligible = await seedCancelledStage();
    const recovery = createApprovedSmsRecoveryService({
      database: database.db,
      clock: { now: () => now },
      publisher: publisher()
    });
    const preview = await recovery.preview({
      organisationId: eligible.organisationId,
      localDate: '2026-09-30'
    });

    await database.db
      .update(invoices)
      .set({ amountDue: '100.0000', syncVersion: 5 })
      .where(eq(invoices.id, eligible.invoiceId));

    await expect(
      recovery.execute({
        organisationId: eligible.organisationId,
        localDate: '2026-09-30',
        expectedCount: preview.count,
        expectedDigest: preview.digest,
        acknowledgement: approvedSmsRecoveryAcknowledgement('2026-09-30')
      })
    ).rejects.toThrow('RECOVERY_COUNT_CHANGED');

    const [stage] = await database.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, eligible.stageInstanceId));
    const stageApprovals = await database.db
      .select()
      .from(approvals)
      .where(eq(approvals.stageInstanceId, eligible.stageInstanceId));
    expect(stage?.status).toBe('CANCELLED');
    expect(stage?.sourceVersion).toBe(4);
    expect(stageApprovals).toHaveLength(2);
    expect(stageApprovals.every((approval) => approval.status === 'EXPIRED')).toBe(
      true
    );
  });

  it('leaves uncertain publishes queued and records them without claiming failure', async () => {
    const succeeds = await seedCancelledStage();
    const fails = await seedCancelledStage({
      organisationId: succeeds.organisationId
    });
    const publish: JobPublisher['publish'] = (_name, payload) => {
      if (
        'stageInstanceId' in payload &&
        payload.stageInstanceId === fails.stageInstanceId
      ) {
        return Promise.reject(new Error('queue unavailable'));
      }
      return Promise.resolve(randomUUID());
    };
    const recovery = createApprovedSmsRecoveryService({
      database: database.db,
      clock: { now: () => now },
      publisher: { publish }
    });
    const preview = await recovery.preview({
      organisationId: succeeds.organisationId,
      localDate: '2026-09-30'
    });

    const result = await recovery.execute({
      organisationId: succeeds.organisationId,
      localDate: '2026-09-30',
      expectedCount: preview.count,
      expectedDigest: preview.digest,
      acknowledgement: approvedSmsRecoveryAcknowledgement('2026-09-30')
    });

    expect(result).toEqual({
      candidateCount: 2,
      publishedCount: 1,
      failedCount: 0,
      uncertainCount: 1
    });
    const [successfulStage] = await database.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, succeeds.stageInstanceId));
    const [failedStage] = await database.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, fails.stageInstanceId));
    expect(successfulStage?.status).toBe('QUEUED');
    expect(failedStage?.status).toBe('QUEUED');
    const failedApprovals = await database.db
      .select()
      .from(approvals)
      .where(eq(approvals.stageInstanceId, fails.stageInstanceId));
    expect(failedApprovals).toHaveLength(3);
    expect(
      failedApprovals.filter((approval) => approval.status === 'APPROVED')
    ).toHaveLength(1);
    const failureEvents = await database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, fails.organisationId),
          eq(auditEvents.eventType, 'APPROVED_SMS_RECOVERY_QUEUE_UNCERTAIN')
        )
      );
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]?.entityId).toBe(fails.stageInstanceId);
  });
});
