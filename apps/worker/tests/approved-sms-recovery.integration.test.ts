import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

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
  invoiceId: string;
  organisationId: string;
  stageInstanceId: string;
}

async function seedCancelledStage(options: {
  organisationId?: string;
  decidedAt?: Date | null;
  origin?: 'AUTOMATION' | 'MANUAL_REMINDER' | 'ESCALATION_SMS';
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
    invoiceNumber: `REC-${invoiceId}`,
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
    template:
      'Hi {{customer_name}}, invoice {{invoice_number}} for {{currency}} {{amount_due}} was due {{due_date}}. {{online_invoice_url}}'
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
    sourceVersion: 3,
    completedAt: new Date('2026-09-30T00:05:00.000Z')
  });
  await database.db.insert(approvals).values({
    id: approvalId,
    organisationId,
    stageInstanceId,
    renderedPreview: 'Approved customer reminder',
    sourceVersion: 3,
    status: 'EXPIRED',
    decidedByUserId: options.decidedAt === null ? null : adminId,
    decidedAt:
      options.decidedAt === undefined
        ? new Date('2026-09-30T00:00:00.000Z')
        : options.decidedAt,
    expiresAt: new Date('2026-10-01T00:00:00.000Z')
  });
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

  return { approvalId, invoiceId, organisationId, stageInstanceId };
}

describe('approved SMS recovery', () => {
  it('regenerates only today\'s approved, unsent automation SMS as fresh pending approvals', async () => {
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

    const recovery = createApprovedSmsRecoveryService({
      database: database.db,
      clock: { now: () => now }
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
    expect(result).toEqual({ regeneratedCount: 1 });

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
    const regeneratedApproval = stageApprovals.find(
      (approval) => approval.id !== eligible.approvalId
    );
    expect(stage?.status).toBe('AWAITING_APPROVAL');
    expect(stage?.sourceVersion).toBe(4);
    expect(stage?.completedAt).toBeNull();
    expect(originalApproval?.status).toBe('EXPIRED');
    expect(regeneratedApproval).toMatchObject({
      sourceVersion: 4,
      status: 'PENDING',
      decidedAt: null,
      decidedByUserId: null,
      expiresAt: new Date('2026-10-01T03:30:00.000Z')
    });
    expect(regeneratedApproval?.renderedPreview).toContain(
      'Recovery customer'
    );
    expect(regeneratedApproval?.renderedPreview).toContain(
      `https://pay.example.invalid/${eligible.invoiceId}`
    );

    const events = await database.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, eligible.organisationId),
          eq(auditEvents.eventType, 'APPROVED_SMS_RECOVERY_REGENERATED')
        )
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe(eligible.stageInstanceId);
  });

  it('makes no changes when the reviewed candidate digest has changed', async () => {
    const eligible = await seedCancelledStage();
    const recovery = createApprovedSmsRecoveryService({
      database: database.db,
      clock: { now: () => now }
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
    ).rejects.toThrow('RECOVERY_PREVIEW_CHANGED');

    const [stage] = await database.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, eligible.stageInstanceId));
    const stageApprovals = await database.db
      .select()
      .from(approvals)
      .where(eq(approvals.stageInstanceId, eligible.stageInstanceId));
    expect(stage?.status).toBe('CANCELLED');
    expect(stage?.sourceVersion).toBe(3);
    expect(stageApprovals).toHaveLength(1);
    expect(stageApprovals[0]?.status).toBe('EXPIRED');
  });
});
