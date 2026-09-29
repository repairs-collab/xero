import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthorizationFailure, type AppSession } from '@bc5000/auth';
import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  organisations,
  outboundMessages,
  users
} from '@bc5000/db';
import type { JobPublisher } from '@bc5000/jobs';

import { settingsCardsForRole } from '../src/app/(protected)/settings/settings-cards.js';
import { createTestSmsService } from '../src/app/(protected)/settings/test-sms/test-sms-service.js';
import {
  createTestSmsPreview,
  TestSmsForm
} from '../src/components/test-sms-form.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-28T03:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

async function seed() {
  const organisationId = randomUUID();
  const userId = randomUUID();
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Test SMS organisation',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'SMS Administrator'
  });
  const session = (role: 'ADMIN' | 'OPERATOR'): AppSession => ({
    userId,
    cognitoSubject: randomUUID(),
    displayName: 'SMS Administrator',
    expiresAt: '2026-09-29T00:00:00.000Z',
    memberships: [{ organisationId, role, active: true }]
  });
  return { organisationId, userId, session };
}

const createPublisher = () =>
  ({ publish: vi.fn(() => Promise.resolve(randomUUID())) }) satisfies JobPublisher;

describe('test SMS queue service', () => {
  it('shows the Test SMS settings card only to Administrators', () => {
    expect(settingsCardsForRole('ADMIN').map((card) => card.href)).toContain(
      '/settings/test-sms'
    );
    expect(settingsCardsForRole('OPERATOR').map((card) => card.href)).not.toContain(
      '/settings/test-sms'
    );
  });

  it('renders a stable request ID, dry-run guidance, and no provider secrets', () => {
    const requestId = randomUUID();
    const html = renderToStaticMarkup(
      createElement(TestSmsForm, {
        organisationId: randomUUID(),
        requestId,
        sendMode: 'dry-run'
      })
    );

    expect(html).toContain(`value="${requestId}"`);
    expect(html.match(new RegExp(requestId, 'g'))).toHaveLength(1);
    expect(html).toContain('No SMS will be sent to a phone while dry-run mode is active');
    expect(html).toContain('I confirm this test SMS is ready');
    expect(html).not.toMatch(/api[-_ ]?key|client secret|authorization:/i);
  });

  it('provides encoding, segment, and validation feedback before submission', () => {
    expect(createTestSmsPreview('AccountPulse test message')).toMatchObject({
      segmentCount: 1,
      error: null
    });
    expect(createTestSmsPreview('')).toMatchObject({
      error: 'Enter a message to preview its SMS length.'
    });
    expect(createTestSmsPreview('A'.repeat(500))).toMatchObject({
      error: 'This message exceeds the 3-segment test limit.'
    });
  });

  it('is Administrator-only and requires explicit confirmation', async () => {
    const seeded = await seed();
    const service = createTestSmsService({
      database: client.db,
      publisher: createPublisher(),
      clock: { now: () => now }
    });
    const request = {
      organisationId: seeded.organisationId,
      destination: '0400 000 001',
      content: 'AccountPulse test message',
      confirmed: true,
      requestId: randomUUID()
    };

    await expect(service.queue(seeded.session('OPERATOR'), request)).rejects.toBeInstanceOf(
      AuthorizationFailure
    );
    await expect(
      service.queue(seeded.session('ADMIN'), { ...request, confirmed: false })
    ).rejects.toThrow('TEST_SMS_CONFIRMATION_REQUIRED');
  });

  it('validates Australian numbers and the three-segment safety cap', async () => {
    const seeded = await seed();
    const service = createTestSmsService({
      database: client.db,
      publisher: createPublisher(),
      clock: { now: () => now }
    });
    const base = {
      organisationId: seeded.organisationId,
      confirmed: true,
      requestId: randomUUID()
    };

    await expect(
      service.queue(seeded.session('ADMIN'), {
        ...base,
        destination: 'not-a-number',
        content: 'Test'
      })
    ).rejects.toThrow('INVALID_AU_MOBILE_NUMBER');
    await expect(
      service.queue(seeded.session('ADMIN'), {
        ...base,
        destination: '(02) 9374 4000',
        content: 'Test'
      })
    ).rejects.toThrow('INVALID_AU_MOBILE_NUMBER');
    await expect(
      service.queue(seeded.session('ADMIN'), {
        ...base,
        destination: '0400 000 001',
        content: 'A'.repeat(500)
      })
    ).rejects.toThrow('TEST_SMS_EXCEEDS_3_SEGMENT_LIMIT');
  });

  it('queues one canonical Outbox entry with exact content and an audit event', async () => {
    const seeded = await seed();
    const publisher = createPublisher();
    const service = createTestSmsService({
      database: client.db,
      publisher,
      clock: { now: () => now }
    });
    const requestId = randomUUID();
    const input = {
      organisationId: seeded.organisationId,
      destination: '0400 000 001',
      content: 'AccountPulse exact test — do not alter',
      confirmed: true,
      requestId
    };

    const first = await service.queue(seeded.session('ADMIN'), input);
    const second = await service.queue(seeded.session('ADMIN'), input);

    expect(second.outboundMessageId).toBe(first.outboundMessageId);
    expect(first).toMatchObject({
      destination: '+61400000001',
      status: 'QUEUED'
    });
    expect(publisher.publish).toHaveBeenLastCalledWith(
      'test-sms.execute',
      {
        organisationId: seeded.organisationId,
        outboundMessageId: first.outboundMessageId
      },
      { singletonKey: `test-sms:${first.outboundMessageId}` }
    );

    const messages = await client.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.organisationId, seeded.organisationId));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      actorUserId: seeded.userId,
      contactId: null,
      invoiceId: null,
      stageInstanceId: null,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: '+61400000001',
      content: input.content,
      status: 'QUEUED',
      idempotencyKey: `test-sms:${requestId}`
    });
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, seeded.organisationId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: seeded.userId,
      eventType: 'TEST_SMS_QUEUED',
      entityType: 'OUTBOUND_MESSAGE',
      entityId: first.outboundMessageId
    });
    expect(JSON.stringify(events[0]?.afterValue)).not.toContain(input.content);
  });

  it('refuses a Test SMS during maintenance without creating Outbox or audit rows', async () => {
    const seeded = await seed();
    await client.db
      .update(organisations)
      .set({ maintenanceMode: true })
      .where(eq(organisations.id, seeded.organisationId));
    const publisher = createPublisher();
    const service = createTestSmsService({
      database: client.db,
      publisher,
      clock: { now: () => now }
    });

    await expect(
      service.queue(seeded.session('ADMIN'), {
        organisationId: seeded.organisationId,
        destination: '0400 000 001',
        content: 'Maintenance safety test',
        confirmed: true,
        requestId: randomUUID()
      })
    ).rejects.toThrow('OPERATIONAL_MAINTENANCE');

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(
      await client.db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.organisationId, seeded.organisationId))
    ).toHaveLength(0);
    expect(
      await client.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.organisationId, seeded.organisationId))
    ).toHaveLength(0);
  });
});
