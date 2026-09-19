import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  contactChannels,
  contacts,
  conversations,
  createDatabase,
  inboundMessages,
  invoiceChases,
  invoices,
  messageAttempts,
  migrateDatabase,
  organisations,
  outboundMessages,
  pauses,
  PostgresWebhookRepository,
  reminderSequences,
  reminderSequenceVersions,
  stageInstances,
  suppressions
} from '@bc5000/db';
import { jobNames, type JobPublisher } from '@bc5000/jobs';

import { processWebhookEvent } from '../src/handlers/webhook-process.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const published: Array<{ name: string; payload: unknown }> = [];
const publisher: JobPublisher = {
  publish(name, payload) {
    published.push({ name, payload });
    return Promise.resolve(randomUUID());
  }
};

beforeAll(async () => {
  await migrateDatabase(client.db);
});

afterAll(async () => {
  await client.pool.end();
});

const seedCustomerChase = async () => {
  const organisationId = randomUUID();
  const contactId = randomUUID();
  const invoiceId = randomUUID();
  const sequenceId = randomUUID();
  const sequenceVersionId = randomUUID();
  const chaseId = randomUUID();
  const stageInstanceId = randomUUID();
  const phone = `+614${Math.floor(100_000_00 + Math.random() * 899_999_99).toString()}`;

  await client.db.insert(organisations).values({
    id: organisationId,
    name: 'Webhook Worker Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(contacts).values({
    id: contactId,
    organisationId,
    xeroContactId: randomUUID(),
    name: 'Reply Customer',
    active: true
  });
  await client.db.insert(contactChannels).values({
    organisationId,
    contactId,
    kind: 'SMS',
    sourceValue: phone,
    normalisedValue: phone,
    usable: true
  });
  await client.db.insert(invoices).values({
    id: invoiceId,
    organisationId,
    xeroInvoiceId: randomUUID(),
    contactId,
    invoiceNumber: 'INV-WEBHOOK',
    type: 'ACCREC',
    status: 'AUTHORISED',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    amountDue: '99.0000',
    currency: 'AUD',
    syncVersion: 1
  });
  await client.db.insert(reminderSequences).values({
    id: sequenceId,
    organisationId,
    name: `Webhook sequence ${sequenceId}`,
    mode: 'REVIEW'
  });
  await client.db.insert(reminderSequenceVersions).values({
    id: sequenceVersionId,
    organisationId,
    sequenceId,
    versionNumber: 1,
    status: 'ACTIVE',
    configuration: {}
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
    id: stageInstanceId,
    organisationId,
    invoiceChaseId: chaseId,
    sequenceVersionId,
    stageKey: 'seven-days',
    channel: 'SMS',
    status: 'QUEUED',
    scheduledAt: new Date('2026-09-18T00:00:00Z'),
    sourceVersion: 1
  });
  return {
    organisationId,
    contactId,
    invoiceId,
    sequenceId,
    chaseId,
    stageInstanceId,
    phone
  };
};

const recordEvent = async (
  organisationId: string,
  provider: 'XERO' | 'SINCH',
  providerEventId: string,
  body: object
) =>
  new PostgresWebhookRepository(client.db).recordOnceWithId({
    organisationId,
    provider,
    providerEventId,
    rawBody: JSON.stringify(body),
    signatureValid: true
  });

describe('processWebhookEvent', () => {
  it('creates an inbox conversation and pauses every active chase on a reply without message_id', async () => {
    const seeded = await seedCustomerChase();
    const recorded = await recordEvent(
      seeded.organisationId,
      'SINCH',
      randomUUID(),
      {
        event_type: 'REPLY',
        reply_id: randomUUID(),
        source_number: seeded.phone,
        destination_number: '+61400000002',
        received_date: '2026-09-18T01:02:03Z',
        content: 'Can we pay Friday?',
        metadata: {}
      }
    );
    const payload = {
      organisationId: seeded.organisationId,
      webhookEventId: recorded.id,
      provider: 'SINCH' as const
    };

    await processWebhookEvent({ database: client.db, publisher }, payload);
    await processWebhookEvent({ database: client.db, publisher }, payload);

    const threads = await client.db
      .select()
      .from(conversations)
      .where(eq(conversations.organisationId, seeded.organisationId));
    const inbound = await client.db
      .select()
      .from(inboundMessages)
      .where(eq(inboundMessages.organisationId, seeded.organisationId));
    const activePauses = await client.db
      .select()
      .from(pauses)
      .where(eq(pauses.organisationId, seeded.organisationId));
    const [chase] = await client.db
      .select()
      .from(invoiceChases)
      .where(eq(invoiceChases.id, seeded.chaseId));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ unreadCount: 1, assignedUserId: null });
    expect(inbound).toHaveLength(1);
    expect(activePauses).toHaveLength(1);
    expect(activePauses[0]).toMatchObject({
      kind: 'REPLY',
      scope: 'customer',
      contactId: seeded.contactId
    });
    expect(chase?.status).toBe('PAUSED');
  });

  it('records an unsolicited opt-out and cancels pending SMS work', async () => {
    const seeded = await seedCustomerChase();
    const recorded = await recordEvent(
      seeded.organisationId,
      'SINCH',
      randomUUID(),
      {
        event_type: 'OPT_OUT',
        notification_id: randomUUID(),
        source_number: seeded.phone,
        destination_number: '+61400000002',
        received_date: '2026-09-18T01:02:03Z',
        content: 'STOP'
      }
    );

    await processWebhookEvent(
      { database: client.db, publisher },
      {
        organisationId: seeded.organisationId,
        webhookEventId: recorded.id,
        provider: 'SINCH'
      }
    );

    const [suppression] = await client.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.organisationId, seeded.organisationId));
    const [stage] = await client.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, seeded.stageInstanceId));
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(suppression).toMatchObject({
      normalisedDestination: seeded.phone,
      consentState: 'SUPPRESSED'
    });
    expect(stage?.status).toBe('CANCELLED');
    expect(events.map((event) => event.eventType)).toContain('SMS_OPT_OUT');
  });

  it('does not let an older nonterminal delivery overwrite delivered', async () => {
    const seeded = await seedCustomerChase();
    const [outbound] = await client.db
      .insert(outboundMessages)
      .values({
        organisationId: seeded.organisationId,
        stageInstanceId: seeded.stageInstanceId,
        channel: 'SMS',
        recipientKey: seeded.phone,
        sourceVersion: 1,
        status: 'ACCEPTED',
        idempotencyKey: randomUUID()
      })
      .returning();
    if (outbound === undefined) throw new Error('Outbound seed failed');
    await client.db.insert(messageAttempts).values({
      organisationId: seeded.organisationId,
      outboundMessageId: outbound.id,
      attemptNumber: 1,
      provider: 'SINCH',
      providerMessageId: 'provider-message-monotonic',
      status: 'ACCEPTED'
    });
    const delivered = await recordEvent(
      seeded.organisationId,
      'SINCH',
      randomUUID(),
      {
        event_type: 'DELIVERY_REPORT',
        message_id: 'provider-message-monotonic',
        status: 'DELIVERED',
        status_code: 0,
        timestamp: '2026-09-18T01:03:00Z',
        metadata: {}
      }
    );
    const queued = await recordEvent(
      seeded.organisationId,
      'SINCH',
      randomUUID(),
      {
        event_type: 'DELIVERY_REPORT',
        message_id: 'provider-message-monotonic',
        status: 'QUEUED',
        status_code: 100,
        timestamp: '2026-09-18T01:02:00Z',
        metadata: {}
      }
    );

    for (const event of [delivered, queued]) {
      await processWebhookEvent(
        { database: client.db, publisher },
        {
          organisationId: seeded.organisationId,
          webhookEventId: event.id,
          provider: 'SINCH'
        }
      );
    }
    const [stored] = await client.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, outbound.id));
    expect(stored?.status).toBe('DELIVERED');
  });

  it('enqueues one targeted refresh for a Xero invoice event', async () => {
    const seeded = await seedCustomerChase();
    const xeroInvoiceId = randomUUID();
    const recorded = await recordEvent(
      seeded.organisationId,
      'XERO',
      `${xeroInvoiceId}:UPDATE:2026-09-18T01:00:00Z`,
      {
        events: [
          {
            resourceId: xeroInvoiceId,
            eventCategory: 'INVOICE',
            eventType: 'UPDATE',
            eventDateUtc: '2026-09-18T01:00:00Z'
          }
        ]
      }
    );

    await processWebhookEvent(
      { database: client.db, publisher },
      {
        organisationId: seeded.organisationId,
        webhookEventId: recorded.id,
        provider: 'XERO'
      }
    );

    expect(published.at(-1)).toMatchObject({
      name: jobNames.xeroInvoiceRefresh,
      payload: {
        organisationId: seeded.organisationId,
        invoiceId: xeroInvoiceId,
        webhookEventId: recorded.id
      }
    });
  });
});
