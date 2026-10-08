import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  contacts,
  invoices,
  organisations,
  suppressions,
  tasks,
  users,
  voiceCallEvents,
  voiceCallInvoices,
  voiceCallRequests
} from '../schema/index.js';
import { PostgresActivityRepository } from './activity-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

describe('PostgresActivityRepository voice timeline', () => {
  it('returns useful voice milestones without contact or provider secrets', async () => {
    const organisationId = randomUUID();
    const contactId = randomUUID();
    const invoiceId = randomUUID();
    const voiceCallId = randomUUID();
    const actorUserId = randomUUID();
    const destination = '+61400000001';
    const approvedAt = new Date('2026-10-08T00:30:00.000Z');

    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Timeline test',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(users).values({
      id: actorUserId,
      cognitoSubject: randomUUID(),
      email: `${actorUserId}@example.invalid`,
      displayName: 'Repairs Admin'
    });
    await client.db.insert(contacts).values({
      id: contactId,
      organisationId,
      xeroContactId: randomUUID(),
      name: 'Timeline Customer',
      active: true,
      sourceVersion: 1
    });
    await client.db.insert(invoices).values({
      id: invoiceId,
      organisationId,
      xeroInvoiceId: randomUUID(),
      contactId,
      invoiceNumber: 'INV-SAFE-100',
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '100.0000',
      total: '100.0000',
      currency: 'AUD',
      syncVersion: 1,
      xeroUpdatedAt: approvedAt
    });
    await client.db.insert(voiceCallRequests).values({
      id: voiceCallId,
      organisationId,
      contactId,
      actorUserId,
      provider: 'RETELL',
      destinationNumber: destination,
      outboundNumber: '+61255501234',
      combinedAmount: '100.0000',
      currency: 'AUD',
      agentId: 'agent_accountpulse',
      agentVersion: 1,
      voiceId: 'voice_au',
      voiceSettingsUpdatedAt: approvedAt,
      transferTargetLabel: 'Main office',
      idempotencyKey: randomUUID(),
      state: 'DRAFT'
    });
    await client.db.insert(voiceCallInvoices).values({
      voiceCallId,
      organisationId,
      invoiceId,
      xeroInvoiceId: randomUUID(),
      invoiceNumber: 'INV-SAFE-100',
      amountDue: '100.0000',
      currency: 'AUD',
      dueDate: '2026-08-31',
      syncVersion: 1,
      snapshotAt: approvedAt
    });
    await client.db
      .update(voiceCallRequests)
      .set({
        callFlowVersion: 1,
        callFlowHash: 'sha256:flow',
        approvedFactsHash: 'sha256:facts',
        state: 'COMPLETED',
        outcome: 'REMINDER_DELIVERED',
        providerCallId: `call_${randomUUID()}`,
        approvedAt,
        queuedAt: new Date('2026-10-08T00:31:00.000Z'),
        providerAcceptedAt: new Date('2026-10-08T00:32:00.000Z'),
        completedAt: new Date('2026-10-08T00:35:00.000Z')
      })
      .where(eq(voiceCallRequests.id, voiceCallId));
    await client.db.insert(voiceCallEvents).values({
      organisationId,
      voiceCallId,
      providerEventKey: randomUUID(),
      eventType: 'VOICE_REMINDER_DELIVERED',
      safeState: 'COMPLETED',
      safeOutcome: 'REMINDER_DELIVERED',
      safeMetadata: {
        transcript: 'must never be shown',
        recording: 'must never be shown'
      },
      occurredAt: new Date('2026-10-08T00:34:00.000Z')
    });
    await client.db.insert(tasks).values({
      organisationId,
      contactId,
      kind: 'VOICE_OUTCOME_REVIEW',
      summary: 'Outcome could not be confirmed safely'
    });
    await client.db.insert(suppressions).values({
      organisationId,
      channel: 'VOICE',
      normalisedDestination: destination,
      source: 'WRONG_PERSON',
      reason: 'Wrong person reported',
      consentState: 'SUPPRESSED'
    });
    const testVoiceCallId = randomUUID();
    await client.db.insert(voiceCallRequests).values({
      id: testVoiceCallId,
      organisationId,
      contactId,
      actorUserId,
      provider: 'RETELL',
      purpose: 'TEST',
      destinationNumber: '+61400000002',
      outboundNumber: '+61255501234',
      combinedAmount: '100.0000',
      currency: 'AUD',
      agentId: 'agent_accountpulse',
      agentVersion: 1,
      voiceId: 'voice_au',
      voiceSettingsUpdatedAt: approvedAt,
      transferTargetLabel: 'Main office',
      idempotencyKey: randomUUID(),
      state: 'DRAFT'
    });
    await client.db.insert(voiceCallInvoices).values({
      voiceCallId: testVoiceCallId,
      organisationId,
      invoiceId,
      xeroInvoiceId: randomUUID(),
      invoiceNumber: 'INV-SAFE-100',
      amountDue: '100.0000',
      currency: 'AUD',
      dueDate: '2026-08-31',
      syncVersion: 1,
      snapshotAt: approvedAt
    });
    await client.db
      .update(voiceCallRequests)
      .set({
        callFlowVersion: 1,
        callFlowHash: 'sha256:test-flow',
        approvedFactsHash: 'sha256:test-facts',
        state: 'COMPLETED',
        outcome: 'REMINDER_DELIVERED',
        approvedAt,
        queuedAt: new Date('2026-10-08T00:31:00.000Z'),
        providerAcceptedAt: new Date('2026-10-08T00:32:00.000Z'),
        completedAt: new Date('2026-10-08T00:35:00.000Z')
      })
      .where(eq(voiceCallRequests.id, testVoiceCallId));
    await client.db.insert(voiceCallEvents).values({
      organisationId,
      voiceCallId: testVoiceCallId,
      providerEventKey: randomUUID(),
      eventType: 'VOICE_REMINDER_DELIVERED',
      safeState: 'COMPLETED',
      safeOutcome: 'REMINDER_DELIVERED',
      occurredAt: new Date('2026-10-08T00:34:30.000Z')
    });

    const timeline = await new PostgresActivityRepository(
      client.db
    ).customerTimeline(organisationId, contactId);
    const serialised = JSON.stringify(timeline);

    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Voice reminder delivered',
          detail: 'Invoice INV-SAFE-100 · initiated by Repairs Admin'
        }),
        expect.objectContaining({
          label: 'Voice outcome needs review',
          href: '/escalations'
        }),
        expect.objectContaining({
          label: 'Voice reminders suppressed',
          href: '/escalations'
        }),
        expect.objectContaining({
          label: 'TEST - Voice reminder delivered',
          source: 'AccountPulse Voice - TEST',
          detail: 'TEST - Invoice INV-SAFE-100 · initiated by Repairs Admin'
        })
      ])
    );
    expect(serialised).not.toContain(destination);
    expect(serialised).not.toContain('must never be shown');
    expect(serialised).not.toContain('providerCallId');
  });
});
