import { randomUUID } from 'node:crypto';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  approvals,
  contactChannels,
  contacts,
  createDatabase,
  invoiceChases,
  invoices,
  migrateDatabase,
  organisations,
  organisationVoiceSettings,
  PostgresVoiceCallRepository,
  reminderSequenceVersions,
  reminderSequences,
  stageInstances,
  users,
  voiceCallRequests
} from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { createApprovalService } from '../src/app/(protected)/approvals/approval-service.js';
import { createVoiceApprovalService } from '../src/app/(protected)/approvals/voice-approval-service.js';
import { ApprovalTable } from '../src/components/approval-table.js';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { ...props, href, children })
}));

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

async function seedVoiceApprovals() {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const sequenceId = randomUUID();
  const versionId = randomUUID();
  const settingsUpdatedAt = new Date('2026-09-18T01:00:00.000Z');
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Voice approval test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true,
    operationalState: 'READY',
    lastSuccessfulSyncAt: new Date('2026-09-18T01:45:00.000Z')
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Voice approval operator'
  });
  await client.db.insert(organisationVoiceSettings).values({
    organisationId,
    enabled: true,
    automaticEnabled: false,
    provider: 'VOIPCLOUD',
    agentId: 'agent-accountpulse',
    agentVersion: 7,
    voiceId: 'voice-au-1',
    voipcloudUserNumber: '1099',
    ttsVoiceId: 'en_GB-alba-medium',
    gatewayFlowVersion: 1,
    outboundNumber: '+61255501234',
    fallbackOfficeNumber: '+61350324518',
    officeDestinationLabel: 'Main office accounts queue',
    timezone: 'Australia/Sydney',
    weekdayStartLocal: '09:00',
    weekdayEndLocal: '17:00',
    updatedAt: settingsUpdatedAt
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: 'Voice review sequence',
    kind: 'VOICE',
    mode: 'REVIEW',
    enabled: true
  });
  await client.db.insert(reminderSequenceVersions).values({
    id: versionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {
      allowedCurrencies: ['AUD'],
      maxCallsPerRun: 5,
      cooldownSeconds: 120
    }
  });
  const repository = new PostgresVoiceCallRepository(client.db);
  const addCall = async (label: string, amountDue: string) => {
    const contactId = randomUUID();
    const invoiceId = randomUUID();
    await client.db.insert(contacts).values({
      id: contactId,
      organisationId,
      xeroContactId: randomUUID(),
      name: `Voice Customer ${label}`,
      active: true
    });
    await client.db.insert(contactChannels).values({
      organisationId,
      contactId,
      kind: 'VOICE',
      sourceValue: '0412 345 678',
      normalisedValue: '+61412345678',
      usable: true
    });
    await client.db.insert(invoices).values({
      id: invoiceId,
      organisationId,
      xeroInvoiceId: `xero-${invoiceId}`,
      contactId,
      invoiceNumber: `VOICE-${label}`,
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue,
      total: amountDue,
      currency: 'AUD',
      syncVersion: 4
    });
    await client.db.insert(invoiceChases).values({
      organisationId,
      invoiceId,
      sequenceId,
      customerId: contactId,
      status: 'ACTIVE'
    });
    const call = await repository.createPrepared({
      organisationId,
      contactId,
      actorUserId: null,
      accountName: `Voice Customer ${label}`,
      destinationNumber: '+61412345678',
      outboundNumber: '+61255501234',
      combinedAmount: amountDue,
      currency: 'AUD',
      voipcloudUserNumber: '1099',
      ttsVoiceId: 'en_GB-alba-medium',
      gatewayFlowVersion: 1,
      agentId: 'agent-accountpulse',
      agentVersion: 7,
      voiceId: 'voice-au-1',
      voiceSettingsUpdatedAt: settingsUpdatedAt,
      transferTargetLabel: 'Main office accounts queue',
      idempotencyKey: `voice-approval-${randomUUID()}`,
      initialState: 'DRAFT',
      source: {
        source: 'SEQUENCE_REVIEW',
        sequenceId,
        sequenceVersionId: versionId,
        stageKey: 'twenty-one-days-voice',
        scheduledAt: now,
        localOccurrenceDate: '2026-09-18'
      },
      callFlowVersion: null,
      callFlowHash: null,
      approvedFactsHash: null,
      invoices: [
        {
          invoiceId,
          xeroInvoiceId: `xero-${invoiceId}`,
          invoiceNumber: `VOICE-${label}`,
          amountDue,
          currency: 'AUD',
          dueDate: '2026-08-31',
          syncVersion: 4,
          snapshotAt: now
        }
      ],
      now
    });
    return { voiceCallId: call.id, contactId, invoiceId };
  };
  const valid = await addCall('VALID', '100.0000');
  const stale = await addCall('STALE', '75.0000');
  const session: AppSession = {
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'Voice approval operator',
    expiresAt: '2026-09-18T10:00:00.000Z',
    memberships: [{ organisationId, role: 'OPERATOR', active: true }]
  };
  return {
    organisationId,
    userId,
    sequenceId,
    versionId,
    repository,
    session,
    valid,
    stale
  };
}

const publisher = () => ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

describe('approval decisions', () => {
  it('links approval targets and offers confirmed invoice and client stop controls', () => {
    const contactId = randomUUID();
    const invoiceId = randomUUID();
    const html = renderToStaticMarkup(
      createElement(ApprovalTable, {
        rows: [
          {
            kind: 'MESSAGE',
            id: randomUUID(),
            organisationId: randomUUID(),
            contactId,
            invoiceId,
            customer: 'Test Customer',
            invoiceNumber: 'INV-100',
            amount: '$250.00',
            ageDays: 28,
            stage: 'seven-days',
            channel: 'SMS',
            destination: '+61400000001',
            content: 'Reminder preview',
            encoding: 'GSM-7',
            segmentCount: 1,
            sourceVersion: 4,
            eligibility: 'Eligible'
          }
        ]
      })
    );

    expect(html).toContain(`/customers/${contactId}`);
    expect(html).toContain(`/invoices/${invoiceId}`);
    expect(html).toContain('Stop reminders for invoice');
    expect(html).toContain('Stop reminders for client');
    expect(html.match(/name="confirmed"/g)).toHaveLength(2);
    expect(html).toContain('Current and future reminders will stop immediately');
    expect(html).toContain('name="reason"');
  });

  it('renders one voice approval with every included invoice and its combined total', () => {
    const contactId = randomUUID();
    const firstInvoiceId = randomUUID();
    const secondInvoiceId = randomUUID();
    const html = renderToStaticMarkup(
      createElement(ApprovalTable, {
        rows: [
          {
            kind: 'VOICE',
            id: randomUUID(),
            organisationId: randomUUID(),
            contactId,
            customer: 'Voice Customer',
            stage: 'twenty-one-days-voice',
            destination: '+61412345678',
            combinedAmount: '$175.50',
            scheduledAt: '18 Sep 2026, 12:00 pm',
            eligibility: 'Current voice facts verified',
            invoices: [
              {
                invoiceId: firstInvoiceId,
                invoiceNumber: 'VOICE-1',
                amount: '$100.00'
              },
              {
                invoiceId: secondInvoiceId,
                invoiceNumber: 'VOICE-2',
                amount: '$75.50'
              }
            ]
          }
        ]
      })
    );

    expect(html).toContain('Voice call');
    expect(html).toContain('VOICE-1');
    expect(html).toContain('VOICE-2');
    expect(html).toContain('$175.50');
    expect(html).toContain(`/customers/${contactId}`);
    expect(html).toContain(`/invoices/${firstInvoiceId}`);
    expect(html).toContain(`/invoices/${secondInvoiceId}`);
  });

  it('approves a sequence voice call without queueing provider work', async () => {
    const seeded = await seedVoiceApprovals();
    const service = createVoiceApprovalService({
      database: client.db,
      repository: seeded.repository,
      clock: { now: () => now },
      holidays: { list: () => [] }
    });

    await service.approve(seeded.session, {
      organisationId: seeded.organisationId,
      voiceCallId: seeded.valid.voiceCallId
    });
    const [call] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.valid.voiceCallId));

    expect(call).toMatchObject({
      state: 'APPROVED',
      actorUserId: seeded.userId,
      queuedAt: null
    });
    expect(call?.approvedAt).toEqual(now);
  });

  it('rejects a sequence voice call as cancelled', async () => {
    const seeded = await seedVoiceApprovals();
    const service = createVoiceApprovalService({
      database: client.db,
      repository: seeded.repository,
      clock: { now: () => now },
      holidays: { list: () => [] }
    });

    await service.reject(seeded.session, {
      organisationId: seeded.organisationId,
      voiceCallId: seeded.valid.voiceCallId
    });
    const [call] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, seeded.valid.voiceCallId));

    expect(call).toMatchObject({
      state: 'CANCELLED',
      actorUserId: seeded.userId,
      failureCode: 'OPERATOR_REJECTED'
    });
  });

  it('bulk approves valid voice rows while isolating stale rows', async () => {
    const seeded = await seedVoiceApprovals();
    await client.db
      .update(invoices)
      .set({ amountDue: '80.0000', syncVersion: 5 })
      .where(eq(invoices.id, seeded.stale.invoiceId));
    const service = createVoiceApprovalService({
      database: client.db,
      repository: seeded.repository,
      clock: { now: () => now },
      holidays: { list: () => [] }
    });

    const result = await service.bulkApprove(seeded.session, {
      organisationId: seeded.organisationId,
      voiceCallIds: [
        seeded.valid.voiceCallId,
        seeded.stale.voiceCallId
      ]
    });
    const stored = await client.db
      .select({ id: voiceCallRequests.id, state: voiceCallRequests.state })
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.organisationId, seeded.organisationId));

    expect(result).toEqual([
      { voiceCallId: seeded.valid.voiceCallId, status: 'APPROVED' },
      { voiceCallId: seeded.stale.voiceCallId, status: 'STALE' }
    ]);
    expect(stored).toEqual(
      expect.arrayContaining([
        { id: seeded.valid.voiceCallId, state: 'APPROVED' },
        { id: seeded.stale.voiceCallId, state: 'CANCELLED' }
      ])
    );
  });

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

  it('refuses an approval during operational maintenance without changing or queueing it', async () => {
    const seeded = await seedApproval();
    await client.db
      .update(organisations)
      .set({ maintenanceMode: true })
      .where(eq(organisations.id, seeded.organisationId));
    const jobs = publisher();
    const service = createApprovalService({
      database: client.db,
      publisher: jobs,
      clock: { now: () => now }
    });

    await expect(
      service.approveReminder(seeded.session, {
        organisationId: seeded.organisationId,
        approvalId: seeded.approvalId
      })
    ).rejects.toThrow('OPERATIONAL_MAINTENANCE');

    const [approval] = await client.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, seeded.approvalId));
    const [stage] = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, seeded.stageId));
    expect(approval?.status).toBe('PENDING');
    expect(stage?.status).toBe('PENDING_APPROVAL');
    expect(jobs.publish).not.toHaveBeenCalled();
  });
});
