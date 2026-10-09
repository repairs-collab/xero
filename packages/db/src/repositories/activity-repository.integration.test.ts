import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '../client.js';
import {
  contacts,
  invoices,
  organisations,
  reminderSequences,
  reminderSequenceVersions,
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
      kind: 'VOICE_CONTACT_REVIEW',
      summary: `Provider destination ${destination}; providerCallId=private-call-id`
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
          detail: 'Invoice INV-SAFE-100 · initiated by Repairs Admin',
          source: 'AccountPulse Voice - Manual'
        }),
        expect.objectContaining({
          label: 'Voice contact details need review',
          detail: 'Review the customer\'s phone details before another voice reminder.',
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
    expect(serialised).not.toContain('private-call-id');
    expect(serialised).not.toContain('must never be shown');
    expect(serialised).not.toContain('providerCallId');
  });

  it('identifies scheduled sources and links every invoice in a consolidated call', async () => {
    const organisationId = randomUUID();
    const contactId = randomUUID();
    const firstInvoiceId = randomUUID();
    const secondInvoiceId = randomUUID();
    const sequenceId = randomUUID();
    const sequenceVersionId = randomUUID();
    const automaticCallId = randomUUID();
    const reviewCallId = randomUUID();
    const scheduledAt = new Date('2026-10-09T00:00:00.000Z');

    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Scheduled timeline test',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(contacts).values({
      id: contactId,
      organisationId,
      xeroContactId: randomUUID(),
      name: 'Scheduled Customer',
      active: true,
      sourceVersion: 1
    });
    await client.db.insert(invoices).values([
      {
        id: firstInvoiceId,
        organisationId,
        xeroInvoiceId: randomUUID(),
        contactId,
        invoiceNumber: 'INV-SCHEDULE-100',
        type: 'ACCREC',
        status: 'AUTHORISED',
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        amountDue: '100.0000',
        total: '100.0000',
        currency: 'AUD',
        syncVersion: 1,
        xeroUpdatedAt: scheduledAt
      },
      {
        id: secondInvoiceId,
        organisationId,
        xeroInvoiceId: randomUUID(),
        contactId,
        invoiceNumber: 'INV-SCHEDULE-200',
        type: 'ACCREC',
        status: 'AUTHORISED',
        issueDate: '2026-08-02',
        dueDate: '2026-08-31',
        amountDue: '200.0000',
        total: '200.0000',
        currency: 'AUD',
        syncVersion: 1,
        xeroUpdatedAt: scheduledAt
      }
    ]);
    await client.db.insert(reminderSequences).values({
      id: sequenceId,
      organisationId,
      name: 'Voice collections',
      kind: 'VOICE'
    });
    await client.db.insert(reminderSequenceVersions).values({
      id: sequenceVersionId,
      organisationId,
      sequenceId,
      versionNumber: 1,
      status: 'ACTIVE'
    });

    const callFacts = {
      organisationId,
      contactId,
      provider: 'RETELL' as const,
      purpose: 'CUSTOMER' as const,
      sequenceId,
      sequenceVersionId,
      stageKey: 'twenty-one-days',
      scheduledAt,
      localOccurrenceDate: '2026-10-09',
      destinationNumber: '+61400000009',
      outboundNumber: '+61255501234',
      combinedAmount: '300.0000',
      currency: 'AUD',
      agentId: 'agent_accountpulse',
      agentVersion: 1,
      voiceId: 'voice_au',
      voiceSettingsUpdatedAt: scheduledAt,
      transferTargetLabel: 'Main office',
      state: 'DRAFT' as const
    };
    await client.db.insert(voiceCallRequests).values([
      {
        ...callFacts,
        id: automaticCallId,
        source: 'SEQUENCE_AUTOMATIC' as const,
        idempotencyKey: randomUUID()
      },
      {
        ...callFacts,
        id: reviewCallId,
        source: 'SEQUENCE_REVIEW' as const,
        idempotencyKey: randomUUID()
      }
    ]);
    await client.db.insert(voiceCallInvoices).values([
      {
        voiceCallId: automaticCallId,
        organisationId,
        invoiceId: firstInvoiceId,
        xeroInvoiceId: randomUUID(),
        invoiceNumber: 'INV-SCHEDULE-100',
        amountDue: '100.0000',
        currency: 'AUD',
        dueDate: '2026-08-31',
        syncVersion: 1,
        snapshotAt: scheduledAt
      },
      {
        voiceCallId: automaticCallId,
        organisationId,
        invoiceId: secondInvoiceId,
        xeroInvoiceId: randomUUID(),
        invoiceNumber: 'INV-SCHEDULE-200',
        amountDue: '200.0000',
        currency: 'AUD',
        dueDate: '2026-08-31',
        syncVersion: 1,
        snapshotAt: scheduledAt
      },
      {
        voiceCallId: reviewCallId,
        organisationId,
        invoiceId: firstInvoiceId,
        xeroInvoiceId: randomUUID(),
        invoiceNumber: 'INV-SCHEDULE-100',
        amountDue: '100.0000',
        currency: 'AUD',
        dueDate: '2026-08-31',
        syncVersion: 1,
        snapshotAt: scheduledAt
      }
    ]);
    for (const callId of [automaticCallId, reviewCallId]) {
      await client.db.update(voiceCallRequests).set({
        callFlowVersion: 1,
        callFlowHash: 'sha256:flow',
        approvedFactsHash: 'sha256:facts',
        state: 'APPROVED',
        approvedAt: scheduledAt
      }).where(eq(voiceCallRequests.id, callId));
    }

    const timeline = await new PostgresActivityRepository(client.db)
      .customerTimeline(organisationId, contactId);

    const automaticEvent = timeline.find(
      (event) => event.id === `voice:${automaticCallId}:approved`
    );
    const reviewEvent = timeline.find(
      (event) => event.id === `voice:${reviewCallId}:approved`
    );
    expect(automaticEvent).toMatchObject({
      source: 'AccountPulse Voice - Sequence automatic',
      links: [
        { href: `/invoices/${firstInvoiceId}`, label: 'INV-SCHEDULE-100' },
        { href: `/invoices/${secondInvoiceId}`, label: 'INV-SCHEDULE-200' }
      ]
    });
    expect(automaticEvent?.detail).toContain(
      'Voice collections - stage twenty-one-days'
    );
    expect(reviewEvent).toMatchObject({
      source: 'AccountPulse Voice - Sequence review'
    });
  });
});
