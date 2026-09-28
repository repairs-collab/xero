import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthorizationFailure, type AppSession } from '@bc5000/auth';
import {
  approvals,
  auditEvents,
  contacts,
  conversations,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  organisations,
  operatorReplies,
  outboundMessages,
  reminderSequences,
  reminderSequenceVersions,
  reminderWhitelistEntries,
  stageInstances,
  tasks,
  users
} from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { createReminderWhitelistService } from '../src/server/reminder-whitelist-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-28T02:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seedScenario() {
  const organisationId = randomUUID();
  const otherOrganisationId = randomUUID();
  const adminUserId = randomUUID();
  const operatorUserId = randomUUID();
  const contactId = randomUUID();
  const sequenceId = randomUUID();
  const versionId = randomUUID();

  await client.db.insert(organisations).values([
    {
      id: organisationId,
      name: 'Whitelist test',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    },
    {
      id: otherOrganisationId,
      name: 'Other organisation',
      xeroOrganisationId: randomUUID(),
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    }
  ]);
  await client.db.insert(users).values([
    {
      id: adminUserId,
      cognitoSubject: randomUUID(),
      email: `${adminUserId}@example.invalid`,
      displayName: 'Administrator'
    },
    {
      id: operatorUserId,
      cognitoSubject: randomUUID(),
      email: `${operatorUserId}@example.invalid`,
      displayName: 'Operator'
    }
  ]);
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Whitelist Customer'
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Whitelist sequence ${sequenceId}`,
    mode: 'REVIEW'
  });
  await client.db.insert(reminderSequenceVersions).values({
    id: versionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE'
  });

  const invoiceIds = [randomUUID(), randomUUID()];
  const approvalIds: string[] = [];
  const stageIds: string[] = [];
  for (const [index, invoiceId] of invoiceIds.entries()) {
    const chaseId = randomUUID();
    const stageId = randomUUID();
    const approvalId = randomUUID();
    await client.db.insert(invoices).values({
      id: invoiceId,
      organisationId,
      xeroInvoiceId: randomUUID(),
      contactId,
      invoiceNumber: `INV-WL-${index + 1}`,
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '100',
      currency: 'AUD',
      syncVersion: 1
    });
    await client.db.insert(invoiceChases).values({
      id: chaseId,
      organisationId,
      invoiceId,
      customerId: contactId,
      sequenceId,
      status: 'ACTIVE'
    });
    await client.db.insert(stageInstances).values({
      id: stageId,
      organisationId,
      invoiceChaseId: chaseId,
      sequenceVersionId: versionId,
      stageKey: `stage-${index}`,
      channel: 'SMS',
      status: index === 0 ? 'QUEUED' : 'PENDING_APPROVAL',
      scheduledAt: now,
      sourceVersion: 1
    });
    await client.db.insert(approvals).values({
      id: approvalId,
      organisationId,
      stageInstanceId: stageId,
      renderedPreview: `Reminder ${index}`,
      sourceVersion: 1,
      status: index === 0 ? 'APPROVED' : 'PENDING',
      expiresAt: new Date('2026-09-29T00:00:00Z')
    });
    approvalIds.push(approvalId);
    stageIds.push(stageId);
  }

  const queuedOutboundId = randomUUID();
  const acceptedOutboundId = randomUUID();
  const inboxOutboundId = randomUUID();
  const conversationId = randomUUID();
  const replyId = randomUUID();
  await client.db.insert(conversations).values({
    id: conversationId,
    organisationId,
    contactId,
    normalisedNumber: '+61400000000',
    lastMessageAt: now
  });
  await client.db.insert(outboundMessages).values([
    {
      id: queuedOutboundId,
      organisationId,
      stageInstanceId: stageIds[0],
      contactId,
      invoiceId: invoiceIds[0],
      channel: 'SMS',
      source: 'MANUAL_REMINDER',
      recipientKey: '+61400000000',
      sourceVersion: 1,
      content: 'Queued reminder',
      status: 'QUEUED',
      idempotencyKey: randomUUID()
    },
    {
      id: acceptedOutboundId,
      organisationId,
      contactId,
      invoiceId: invoiceIds[0],
      channel: 'SMS',
      source: 'MANUAL_REMINDER',
      recipientKey: '+61400000000',
      content: 'Already accepted',
      status: 'ACCEPTED',
      idempotencyKey: randomUUID()
    },
    {
      id: inboxOutboundId,
      organisationId,
      contactId,
      actorUserId: operatorUserId,
      channel: 'SMS',
      source: 'INBOX_REPLY',
      recipientKey: '+61400000000',
      content: 'Thanks for the update',
      status: 'QUEUED',
      idempotencyKey: `operator-reply:${replyId}`
    }
  ]);
  await client.db.insert(operatorReplies).values({
    id: replyId,
    organisationId,
    conversationId,
    actorUserId: operatorUserId,
    outboundMessageId: inboxOutboundId,
    content: 'Thanks for the update',
    contentHash: 'reply-hash',
    status: 'PENDING',
    idempotencyKey: `operator-reply:${replyId}`,
    createdAt: now,
    updatedAt: now
  });
  const taskId = randomUUID();
  await client.db.insert(tasks).values({
    id: taskId,
    organisationId,
    kind: 'DEBT_ESCALATION',
    contactId,
    invoiceId: invoiceIds[0],
    sequenceId,
    status: 'OPEN',
    summary: 'Call customer'
  });

  const session = (role: 'ADMIN' | 'OPERATOR'): AppSession => ({
    userId: role === 'ADMIN' ? adminUserId : operatorUserId,
    cognitoSubject: randomUUID(),
    displayName: role,
    expiresAt: '2026-09-29T00:00:00Z',
    memberships: [{ organisationId, role, active: true }]
  });
  return {
    organisationId,
    otherOrganisationId,
    contactId,
    invoiceIds,
    stageIds,
    approvalIds,
    queuedOutboundId,
    acceptedOutboundId,
    inboxOutboundId,
    replyId,
    taskId,
    session
  };
}

const publisher = () =>
  ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

describe('Reminder Whitelist lifecycle', () => {
  it('enforces the whitelist reason limit on the server', async () => {
    const seeded = await seedScenario();
    const service = createReminderWhitelistService({
      database: client.db,
      publisher: publisher(),
      clock: { now: () => now }
    });

    await expect(
      service.add(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        scope: 'CLIENT',
        contactId: seeded.contactId,
        reason: 'A'.repeat(501)
      })
    ).rejects.toThrow('REMINDER_WHITELIST_REASON_TOO_LONG');
  });

  it('cancels all unsent client work while preserving accepted history', async () => {
    const seeded = await seedScenario();
    const jobs = publisher();
    const service = createReminderWhitelistService({
      database: client.db,
      publisher: jobs,
      clock: { now: () => now }
    });

    const result = await service.add(seeded.session('OPERATOR'), {
      organisationId: seeded.organisationId,
      scope: 'CLIENT',
      contactId: seeded.contactId,
      reason: 'Customer requested no reminders'
    });

    expect(result).toMatchObject({
      created: true,
      cancelledApprovals: 2,
      cancelledStages: 2,
      cancelledMessages: 1,
      cancelledTasks: 1
    });
    const storedApprovals = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.organisationId, seeded.organisationId));
    const storedStages = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.organisationId, seeded.organisationId));
    const messages = await client.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.organisationId, seeded.organisationId));
    const [task] = await client.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, seeded.taskId));
    expect(storedApprovals.map((row) => row.status)).toEqual([
      'EXPIRED',
      'EXPIRED'
    ]);
    expect(storedStages.map((row) => row.status)).toEqual([
      'CANCELLED',
      'CANCELLED'
    ]);
    expect(messages.find((row) => row.id === seeded.queuedOutboundId)?.status).toBe(
      'CANCELLED'
    );
    expect(messages.find((row) => row.id === seeded.acceptedOutboundId)?.status).toBe(
      'ACCEPTED'
    );
    expect(messages.find((row) => row.id === seeded.inboxOutboundId)?.status).toBe(
      'QUEUED'
    );
    const [reply] = await client.db
      .select()
      .from(operatorReplies)
      .where(eq(operatorReplies.id, seeded.replyId));
    expect(reply?.status).toBe('PENDING');
    expect(task?.status).toBe('CANCELLED');
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'REMINDER_WHITELIST_ADDED',
        'REMINDERS_CANCELLED_BY_WHITELIST'
      ])
    );
  });

  it('limits invoice entries to one invoice and treats repeated adds as a no-op', async () => {
    const seeded = await seedScenario();
    const service = createReminderWhitelistService({
      database: client.db,
      publisher: publisher(),
      clock: { now: () => now }
    });
    const input = {
      organisationId: seeded.organisationId,
      scope: 'INVOICE' as const,
      contactId: seeded.contactId,
      invoiceId: seeded.invoiceIds[0]!
    };

    const first = await service.add(seeded.session('OPERATOR'), input);
    const second = await service.add(seeded.session('OPERATOR'), input);
    expect(first).toMatchObject({ created: true, cancelledApprovals: 1 });
    expect(second).toMatchObject({
      entryId: first.entryId,
      created: false,
      cancelledApprovals: 0,
      cancelledStages: 0,
      cancelledMessages: 0,
      cancelledTasks: 0
    });
    const [otherApproval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, seeded.approvalIds[1]!));
    expect(otherApproval?.status).toBe('PENDING');
  });

  it('allows only an Administrator to remove an entry and queues recalculation', async () => {
    const seeded = await seedScenario();
    const jobs = publisher();
    const service = createReminderWhitelistService({
      database: client.db,
      publisher: jobs,
      clock: { now: () => now }
    });
    const invoiceEntry = await service.add(seeded.session('OPERATOR'), {
      organisationId: seeded.organisationId,
      scope: 'INVOICE',
      contactId: seeded.contactId,
      invoiceId: seeded.invoiceIds[0]!
    });
    await service.add(seeded.session('OPERATOR'), {
      organisationId: seeded.organisationId,
      scope: 'CLIENT',
      contactId: seeded.contactId
    });

    await expect(
      service.remove(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        entryId: invoiceEntry.entryId
      })
    ).rejects.toBeInstanceOf(AuthorizationFailure);
    const removed = await service.remove(seeded.session('ADMIN'), {
      organisationId: seeded.organisationId,
      entryId: invoiceEntry.entryId
    });
    expect(removed).toMatchObject({ removed: true });
    expect(jobs.publish).toHaveBeenCalledWith(
      'reminders.calculate',
      { organisationId: seeded.organisationId },
      { singletonKey: `reminders.calculate:${seeded.organisationId}` }
    );
    const active = await service.list(seeded.session('OPERATOR'), {
      organisationId: seeded.organisationId
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.entry.scope).toBe('CLIENT');
  });

  it('rejects targets and entries owned by another organisation', async () => {
    const seeded = await seedScenario();
    const service = createReminderWhitelistService({
      database: client.db,
      publisher: publisher(),
      clock: { now: () => now }
    });
    await expect(
      service.add(seeded.session('OPERATOR'), {
        organisationId: seeded.organisationId,
        scope: 'CLIENT',
        contactId: randomUUID()
      })
    ).rejects.toThrow('REMINDER_WHITELIST_TARGET_NOT_FOUND');

    const [foreignEntry] = await client.db
      .insert(reminderWhitelistEntries)
      .values({
        organisationId: seeded.organisationId,
        scope: 'CLIENT',
        contactId: seeded.contactId
      })
      .returning();
    if (foreignEntry === undefined) throw new Error('Entry seed failed');
    const foreignAdmin: AppSession = {
      ...seeded.session('ADMIN'),
      memberships: [
        {
          organisationId: seeded.otherOrganisationId,
          role: 'ADMIN',
          active: true
        }
      ]
    };
    await expect(
      service.remove(foreignAdmin, {
        organisationId: seeded.otherOrganisationId,
        entryId: foreignEntry.id
      })
    ).rejects.toThrow('REMINDER_WHITELIST_ENTRY_NOT_FOUND');
    const [stillActive] = await client.db
      .select()
      .from(reminderWhitelistEntries)
      .where(
        and(
          eq(reminderWhitelistEntries.id, foreignEntry.id),
          eq(reminderWhitelistEntries.organisationId, seeded.organisationId)
        )
      );
    expect(stillActive?.removedAt).toBeNull();
  });
});
