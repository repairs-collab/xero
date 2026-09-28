import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import { auditEvents, contactChannels, contacts, createDatabase, invoiceChases, invoices, migrateDatabase, organisations, reminderSequenceVersions, reminderSequences, stageInstances, tasks, users } from '@bc5000/db';

import { createEscalationService } from '../src/app/(protected)/escalations/escalation-service.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T02:00:00.000Z');
beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedEscalation() {
  const organisationId = randomUUID(); const userId = randomUUID(); const contactId = randomUUID(); const invoiceId = randomUUID(); const sequenceId = randomUUID(); const versionId = randomUUID(); const chaseId = randomUUID(); const stageId = randomUUID(); const taskId = randomUUID();
  await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Task test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
  await client.db.insert(users).values({ id: userId, cognitoSubject: randomUUID(), email: `${userId}@example.invalid`, displayName: 'Operator' });
  await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: randomUUID(), name: 'Customer' });
  await client.db.insert(contactChannels).values({ organisationId, contactId, kind: 'SMS', sourceValue: '0400 000 009', normalisedValue: '+61400000009', usable: true });
  await client.db.insert(invoices).values({ id: invoiceId, organisationId, xeroInvoiceId: randomUUID(), contactId, invoiceNumber: 'INV-300', type: 'ACCREC', status: 'AUTHORISED', issueDate: '2026-07-01', dueDate: '2026-07-31', amountDue: '700', currency: 'AUD', onlineInvoiceUrl: 'https://in.xero.test/INV-300', syncVersion: 1 });
  await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Standard', mode: 'REVIEW' });
  await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'ACTIVE', dailyBasis: 'BUSINESS_DAYS' });
  await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId, sequenceId, customerId: contactId, status: 'ACTIVE' });
  await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'daily-after-30', channel: 'SMS', status: 'SCHEDULED', scheduledAt: new Date('2026-09-19T00:00:00Z'), sourceVersion: 1 });
  await client.db.insert(tasks).values({ id: taskId, organisationId, kind: 'DEBT_ESCALATION', contactId, invoiceId, sequenceId, status: 'OPEN', dueAt: now, summary: 'Escalate overdue invoice INV-300' });
  const session: AppSession = { userId, cognitoSubject: randomUUID(), displayName: 'Operator', expiresAt: '2026-09-18T10:00:00Z', memberships: [{ organisationId, role: 'OPERATOR', active: true }] };
  return { organisationId, userId, contactId, invoiceId, stageId, taskId, session };
}

describe('escalation tasks', () => {
  it('requires a resolution note and does not silently stop daily messaging', async () => {
    const seeded = await seedEscalation();
    const service = createEscalationService({ database: client.db, clock: { now: () => now } });
    await expect(service.completeTask(seeded.session, { organisationId: seeded.organisationId, taskId: seeded.taskId, resolutionNote: '  ' })).rejects.toThrow('RESOLUTION_NOTE_REQUIRED');
    await service.completeTask(seeded.session, { organisationId: seeded.organisationId, taskId: seeded.taskId, resolutionNote: 'Spoke to accounts and agreed to call tomorrow.' });
    const [task] = await client.db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    const [stage] = await client.db.select().from(stageInstances).where(eq(stageInstances.id, seeded.stageId));
    expect(task).toMatchObject({ status: 'COMPLETED', resolutionNote: 'Spoke to accounts and agreed to call tomorrow.' });
    expect(stage?.status).toBe('SCHEDULED');
  });

  it('records call-launch intent and returns a normalised tel target without completing the task', async () => {
    const seeded = await seedEscalation();
    const service = createEscalationService({
      database: client.db,
      clock: { now: () => now }
    });

    await expect(
      service.recordCallLinkOpened(seeded.session, {
        organisationId: seeded.organisationId,
        taskId: seeded.taskId
      })
    ).resolves.toEqual({ href: 'tel:+61400000009' });

    const [task] = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, seeded.taskId));
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, seeded.organisationId),
          eq(auditEvents.eventType, 'CALL_LINK_OPENED')
        )
      );
    expect(task?.status).toBe('OPEN');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organisationId: seeded.organisationId,
      actorUserId: seeded.userId,
      entityType: 'TASK',
      entityId: seeded.taskId
    });
    expect(JSON.stringify(events[0]?.afterValue)).not.toContain('+61400000009');
    expect(JSON.stringify(events)).not.toContain('CALL_COMPLETED');
  });

  it('rejects call launch when the task is foreign or no usable number remains', async () => {
    const seeded = await seedEscalation();
    const service = createEscalationService({
      database: client.db,
      clock: { now: () => now }
    });
    await client.db
      .update(contactChannels)
      .set({ usable: false })
      .where(eq(contactChannels.contactId, seeded.contactId));
    await expect(
      service.recordCallLinkOpened(seeded.session, {
        organisationId: seeded.organisationId,
        taskId: seeded.taskId
      })
    ).rejects.toThrow('CALL_PHONE_UNAVAILABLE');
    await expect(
      service.recordCallLinkOpened(seeded.session, {
        organisationId: seeded.organisationId,
        taskId: randomUUID()
      })
    ).rejects.toThrow('ESCALATION_NOT_FOUND');
  });
});
