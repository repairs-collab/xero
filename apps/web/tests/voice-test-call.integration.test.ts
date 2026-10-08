import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@bc5000/auth';
import {
  auditEvents,
  contacts,
  createDatabase,
  invoices,
  memberships,
  migrateDatabase,
  organisations,
  organisationVoiceSettings,
  PostgresVoiceCallRepository,
  users,
  voiceCallRequests
} from '@bc5000/db';
import { fixedVoiceCallCopy } from '@bc5000/domain';
import { jobNames } from '@bc5000/jobs';

import {
  createVoiceTestCallService,
  voiceCallFlowHash
} from '../src/app/(protected)/settings/voice/voice-test-call-service.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-10-08T01:00:00.000Z');

beforeAll(() => migrateDatabase(client.db));
afterAll(() => client.pool.end());

async function seed() {
  const organisationId = randomUUID();
  const adminUserId = randomUUID();
  const operatorUserId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Voice test organisation',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    liveSendAcknowledged: true,
    operationalState: 'RECONCILED',
    lastSuccessfulSyncAt: now
  });
  await client.db.insert(users).values([
    {
      id: adminUserId,
      cognitoSubject: randomUUID(),
      email: `${adminUserId}@example.invalid`,
      displayName: 'Admin'
    },
    {
      id: operatorUserId,
      cognitoSubject: randomUUID(),
      email: `${operatorUserId}@example.invalid`,
      displayName: 'Operator'
    }
  ]);
  await client.db.insert(memberships).values([
    { organisationId, userId: adminUserId, role: 'ADMIN' },
    { organisationId, userId: operatorUserId, role: 'OPERATOR' }
  ]);
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Existing Xero customer',
    active: true,
    sourceVersion: 1
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: `TEST-${invoiceId.slice(0, 8)}`,
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '123.4500',
    total: '123.4500',
    currency: 'AUD',
    syncVersion: 2,
    xeroUpdatedAt: now
  });
  await client.db.insert(organisationVoiceSettings).values({
    organisationId,
    enabled: false,
    configurationVersion: 3,
    secretReference: 'env:RETELL_API_KEY',
    previewPublicKey: 'public_key_test_restricted',
    agentId: 'agent_accountpulse',
    agentVersion: 7,
    voiceId: 'voice_au',
    voiceLabel: 'Australian English',
    voipcloudUserNumber: '1099',
    ttsVoiceId: 'en_GB-alba-medium',
    gatewayFlowVersion: 1,
    outboundNumber: '+61255501234',
    transferSipUri: 'sip:accounts@example.test',
    fallbackOfficeNumber: '+61255504321',
    officeDestinationLabel: 'Main office',
    timezone: 'Australia/Sydney',
    weekdayStartLocal: '09:00:00',
    weekdayEndLocal: '17:00:00',
    lastConnectionTestedAt: now,
    lastConnectionTestSucceeded: true,
    updatedByUserId: adminUserId,
    updatedAt: now
  });
  await client.db.insert(auditEvents).values({
    organisationId,
    actorUserId: adminUserId,
    eventType: 'VOICE_GENERIC_FLOW_TESTED',
    entityType: 'ORGANISATION_VOICE_SETTINGS',
    entityId: organisationId,
    afterValue: {
      passed: true,
      configurationVersion: 3,
      callFlowHash: voiceCallFlowHash,
      callFlowVersion: fixedVoiceCallCopy.version,
      agentId: 'agent_accountpulse',
      agentVersion: 7,
      voiceId: 'voice_au'
    },
    occurredAt: now
  });
  const session = (role: 'ADMIN' | 'OPERATOR'): AppSession => ({
    userId: role === 'ADMIN' ? adminUserId : operatorUserId,
    cognitoSubject: randomUUID(),
    displayName: role,
    expiresAt: '2026-10-09T00:00:00.000Z',
    memberships: [{ organisationId, role, active: true }]
  });
  return {
    organisationId,
    adminUserId,
    contactId,
    invoiceId,
    invoiceNumber: `TEST-${invoiceId.slice(0, 8)}`,
    session
  };
}

describe('voice test call service', () => {
  it('prepares an Administrator-only TEST call using an existing invoice and a staff number', async () => {
    const seeded = await seed();
    const publisher = { publish: vi.fn(() => Promise.resolve(randomUUID())) };
    const service = createVoiceTestCallService({
      database: client.db,
      repository: new PostgresVoiceCallRepository(client.db),
      publisher,
      session: seeded.session('ADMIN'),
      clock: { now: () => now },
      holidays: { list: () => [] }
    });

    const draft = await service.prepare({
      organisationId: seeded.organisationId,
      invoiceNumber: seeded.invoiceNumber.toLowerCase(),
      testNumber: '0400 000 002',
      idempotencyKey: randomUUID()
    });

    expect(draft).toMatchObject({
      purpose: 'TEST',
      invoiceNumber: seeded.invoiceNumber,
      customerName: 'Existing Xero customer',
      destinationNumber: '+61400000002',
      amountDue: '123.45',
      currency: 'AUD',
      ready: true
    });
    const [stored] = await client.db
      .select()
      .from(voiceCallRequests)
      .where(eq(voiceCallRequests.id, draft.voiceCallId));
    expect(stored).toMatchObject({
      purpose: 'TEST',
      destinationNumber: '+61400000002',
      contactId: seeded.contactId,
      state: 'DRAFT'
    });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('rejects Operators, missing invoices, and stale provider evidence', async () => {
    const seeded = await seed();
    const dependencies = {
      database: client.db,
      repository: new PostgresVoiceCallRepository(client.db),
      publisher: { publish: vi.fn(() => Promise.resolve(randomUUID())) },
      clock: { now: () => now },
      holidays: { list: () => [] }
    };
    await expect(
      createVoiceTestCallService({
        ...dependencies,
        session: seeded.session('OPERATOR')
      }).prepare({
        organisationId: seeded.organisationId,
        invoiceNumber: seeded.invoiceNumber,
        testNumber: '+61400000002',
        idempotencyKey: randomUUID()
      })
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      createVoiceTestCallService({
        ...dependencies,
        session: seeded.session('ADMIN')
      }).prepare({
        organisationId: seeded.organisationId,
        invoiceNumber: 'MISSING-INVOICE',
        testNumber: '+61400000002',
        idempotencyKey: randomUUID()
      })
    ).rejects.toThrow('VOICE_TEST_INVOICE_NOT_FOUND');

    await client.db
      .update(organisationVoiceSettings)
      .set({
        lastConnectionTestedAt: new Date(now.getTime() - 25 * 60 * 60_000)
      })
      .where(
        eq(
          organisationVoiceSettings.organisationId,
          seeded.organisationId
        )
      );
    await expect(
      createVoiceTestCallService({
        ...dependencies,
        session: seeded.session('ADMIN')
      }).prepare({
        organisationId: seeded.organisationId,
        invoiceNumber: seeded.invoiceNumber,
        testNumber: '+61400000002',
        idempotencyKey: randomUUID()
      })
    ).rejects.toThrow('VOICE_TEST_PROVIDER_NOT_READY');
  });

  it('approves once, audits it as a test, and republishes only the same singleton execution job', async () => {
    const seeded = await seed();
    const publisher = { publish: vi.fn(() => Promise.resolve(randomUUID())) };
    const service = createVoiceTestCallService({
      database: client.db,
      repository: new PostgresVoiceCallRepository(client.db),
      publisher,
      session: seeded.session('ADMIN'),
      clock: { now: () => now },
      holidays: { list: () => [] }
    });
    const idempotencyKey = randomUUID();
    const draft = await service.prepare({
      organisationId: seeded.organisationId,
      invoiceNumber: seeded.invoiceNumber,
      testNumber: '+61400000002',
      idempotencyKey
    });
    const input = {
      organisationId: seeded.organisationId,
      voiceCallId: draft.voiceCallId,
      idempotencyKey,
      confirmed: true
    };

    await expect(service.approveAndQueue(input)).resolves.toMatchObject({
      voiceCallId: draft.voiceCallId,
      queued: true
    });
    await expect(service.approveAndQueue(input)).resolves.toMatchObject({
      voiceCallId: draft.voiceCallId,
      queued: false
    });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    for (const call of publisher.publish.mock.calls) {
      expect(call).toEqual([
        jobNames.voiceCallExecute,
        expect.objectContaining({
          organisationId: seeded.organisationId,
          voiceCallId: draft.voiceCallId
        }),
        expect.objectContaining({
          singletonKey: `voice-call:${draft.voiceCallId}`
        })
      ]);
    }
    const audits = await client.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, seeded.organisationId),
          eq(auditEvents.entityId, draft.voiceCallId)
        )
      );
    expect(audits.map((event) => event.eventType)).toContain(
      'VOICE_TEST_CALL_FACTS_APPROVED'
    );
    expect(JSON.stringify(audits)).not.toContain('+61400000002');
  });
});
