import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  approvals,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  organisations,
  reminderSequenceVersions,
  reminderSequences,
  stageInstances,
  users
} from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { createApprovalService } from '../src/app/(protected)/approvals/approval-service.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T02:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedApproval(sourceVersion = 4) {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const versionId = randomUUID();
  const chaseId = randomUUID();
  const stageId = randomUUID();
  const approvalId = randomUUID();
  await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Approval test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
  await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Operator' });
  await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Test Customer' });
  await client.db.insert(invoices).values({ id: invoiceId, organisationId, xeroInvoiceId: randomUUID(), contactId, invoiceNumber: 'INV-100', type: 'ACCREC', status: 'AUTHORISED', issueDate: '2026-08-01', dueDate: '2026-08-31', amountDue: '250.0000', total: '250.0000', currency: 'AUD', syncVersion: sourceVersion });
  await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Standard', mode: 'REVIEW' });
  await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'ACTIVE' });
  await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId, sequenceId, customerId: contactId, status: 'ACTIVE' });
  await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'seven-days', channel: 'SMS', status: 'PENDING_APPROVAL', scheduledAt: now, sourceVersion });
  await client.db.insert(approvals).values({ id: approvalId, organisationId, stageInstanceId: stageId, renderedPreview: 'Reminder preview', sourceVersion, status: 'PENDING', expiresAt: new Date('2026-09-19T02:00:00.000Z') });
  const session: AppSession = { userId, cognitoSubject: randomUUID(), displayName: 'Operator', expiresAt: '2026-09-18T10:00:00.000Z', memberships: [{ organisationId, role: 'OPERATOR', active: true }] };
  return { organisationId, invoiceId, stageId, approvalId, session };
}

const publisher = () => ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

describe('approval decisions', () => {
  it('expires an approval when its invoice source version changed', async () => {
    const seeded = await seedApproval();
    await client.db.update(invoices).set({ syncVersion: 5 }).where(eq(invoices.id, seeded.invoiceId));
    const service = createApprovalService({ database: client.db, publisher: publisher(), clock: { now: () => now } });

    await expect(service.approveReminder(seeded.session, { organisationId: seeded.organisationId, approvalId: seeded.approvalId })).rejects.toThrow('APPROVAL_STALE');

    const [approval] = await client.db.select().from(approvals).where(eq(approvals.id, seeded.approvalId));
    const [stage] = await client.db.select().from(stageInstances).where(eq(stageInstances.id, seeded.stageId));
    expect(approval?.status).toBe('EXPIRED');
    expect(stage?.status).toBe('CANCELLED');
  });

  it('bulk approves valid rows while returning stale rows independently', async () => {
    const valid = await seedApproval(1);
    const stale = await seedApproval(2);
    await client.db.update(invoices).set({ syncVersion: 3 }).where(eq(invoices.id, stale.invoiceId));
    const jobs = publisher();
    const service = createApprovalService({ database: client.db, publisher: jobs, clock: { now: () => now } });

    const result = await service.bulkApprove(valid.session, { organisationId: valid.organisationId, approvalIds: [valid.approvalId] });
    const staleResult = await service.bulkApprove(stale.session, { organisationId: stale.organisationId, approvalIds: [stale.approvalId] });

    expect(result).toEqual([{ approvalId: valid.approvalId, status: 'APPROVED' }]);
    expect(staleResult).toEqual([{ approvalId: stale.approvalId, status: 'STALE' }]);
    expect(jobs.publish).toHaveBeenCalledTimes(1);
  });
});
