import {
  createHmac,
  createSign,
  generateKeyPairSync,
  randomUUID
} from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDatabase,
  migrateDatabase,
  organisations,
  PostgresWebhookRepository,
  webhookEvents
} from '@bc5000/db';
import { sinchCallbackCanonicalBytes } from '@bc5000/integrations/sinch';
import { jobNames } from '@bc5000/jobs';

import {
  createRetellWebhookHandler,
  createSinchWebhookHandler,
  createXeroWebhookHandler
} from '../src/server/webhook-handlers.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@localhost:5432/bc5000';
const client = createDatabase(databaseUrl);
const organisationId = randomUUID();
const queued: Array<{
  name: string;
  payload: unknown;
  singletonKey: string;
}> = [];
const queue = {
  enqueueUnique(name: string, payload: unknown, singletonKey: string) {
    const existing = queued.find((job) => job.singletonKey === singletonKey);
    if (existing !== undefined) return Promise.resolve(singletonKey);
    queued.push({ name, payload, singletonKey });
    return Promise.resolve(randomUUID());
  }
};

beforeAll(async () => {
  await migrateDatabase(client.db);
  await client.db.insert(organisations).values({
    id: organisationId,
    name: 'Webhook Endpoint Organisation',
    xeroOrganisationId: randomUUID(),
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD'
  });
});

afterAll(async () => {
  await client.pool.end();
});

describe('public webhook endpoints', () => {
  const retellNow = new Date('2026-10-08T00:00:00.000Z');
  const retellApiKey = 'retell-private-api-key';
  const retellSignature = (
    rawBody: string,
    signedAt = retellNow.getTime()
  ): string =>
    `v=${signedAt},d=${createHmac('sha256', retellApiKey)
      .update(Buffer.from(rawBody))
      .update(String(signedAt))
      .digest('hex')}`;

  it('returns 401 for an invalid Xero signature without enqueuing', async () => {
    const before = queued.length;
    const handler = createXeroWebhookHandler({
      organisationId,
      webhookKey: 'xero-webhook-key',
      repository: new PostgresWebhookRepository(client.db),
      queue
    });
    const response = await handler(
      new Request('https://bill-chaser.test/api/webhooks/xero', {
        method: 'POST',
        headers: { 'x-xero-signature': 'invalid' },
        body: JSON.stringify({ events: [] })
      })
    );

    expect(response.status).toBe(401);
    expect(queued).toHaveLength(before);
  });

  it('persists a valid Xero event once and enqueues targeted processing', async () => {
    const body = JSON.stringify({
      events: [
        {
          resourceId: randomUUID(),
          eventCategory: 'INVOICE',
          eventType: 'UPDATE',
          eventDateUtc: '2026-09-18T01:00:00Z'
        }
      ]
    });
    const signature = createHmac('sha256', 'xero-webhook-key')
      .update(body)
      .digest('base64');
    const handler = createXeroWebhookHandler({
      organisationId,
      webhookKey: 'xero-webhook-key',
      repository: new PostgresWebhookRepository(client.db),
      queue
    });
    const request = () =>
      new Request('https://bill-chaser.test/api/webhooks/xero', {
        method: 'POST',
        headers: { 'x-xero-signature': signature },
        body
      });

    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(200);
    const matching = queued.filter(
      (job) =>
        job.name === jobNames.webhookProcess &&
        (job.payload as { provider?: string }).provider === 'XERO'
    );
    expect(matching).toHaveLength(1);
  });

  it('persists then acknowledges a valid Sinch reply', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048
    });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const date = 'Fri, 18 Sep 2026 01:02:03 GMT';
    const path = '/api/webhooks/sinch';
    const body = JSON.stringify({
      event_type: 'REPLY',
      reply_id: randomUUID(),
      source_number: '+61400000001',
      destination_number: '+61400000002',
      received_date: '2026-09-18T01:02:03Z',
      content: 'Can we pay Friday?',
      metadata: {}
    });
    const signer = createSign('RSA-SHA512');
    signer.update(
      sinchCallbackCanonicalBytes(
        `POST ${path} HTTP/1.1`,
        date,
        Buffer.from(body)
      )
    );
    signer.end();
    const handler = createSinchWebhookHandler({
      organisationId,
      publicKeys: new Map([['key-1', publicKeyPem]]),
      sharedToken: 'sinch-webhook-token',
      repository: new PostgresWebhookRepository(client.db),
      queue
    });
    const response = await handler(
      new Request(`https://bill-chaser.test${path}`, {
        method: 'POST',
        headers: {
          date,
          'x-messagemedia-signature': signer.sign(privateKey).toString('base64'),
          'x-messagemedia-digest-type': 'SHA-512',
          'x-messagemedia-cipher-type': 'RSA',
          'x-messagemedia-key-id': 'key-1'
        },
        body
      })
    );

    expect(response.status).toBe(202);
    const stored = await client.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.organisationId, organisationId));
    expect(stored.some((event) => event.provider === 'SINCH')).toBe(true);
    expect(queued.at(-1)?.name).toBe(jobNames.webhookProcess);
  });

  it('accepts a Sinch Engage webhook authenticated by the shared token', async () => {
    const before = queued.length;
    const replyId = randomUUID();
    const body = JSON.stringify({
      event_type: 'REPLY',
      reply_id: replyId,
      source_number: '+61400000003',
      destination_number: '+61400000004',
      received_date: '2026-09-18T01:02:03Z',
      content: 'Thanks, I will pay today.'
    });
    const handler = createSinchWebhookHandler({
      organisationId,
      publicKeys: new Map(),
      sharedToken: 'sinch-webhook-token',
      repository: new PostgresWebhookRepository(client.db),
      queue
    });

    const response = await handler(
      new Request('https://bill-chaser.test/api/webhooks/sinch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-accountpulse-webhook-token': 'sinch-webhook-token'
        },
        body
      })
    );

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(before + 1);
    expect(queued.at(-1)?.singletonKey).toContain(replyId);
  });

  it('rejects an unsigned Sinch Engage webhook with the wrong shared token', async () => {
    const before = queued.length;
    const handler = createSinchWebhookHandler({
      organisationId,
      publicKeys: new Map(),
      sharedToken: 'sinch-webhook-token',
      repository: new PostgresWebhookRepository(client.db),
      queue
    });

    const response = await handler(
      new Request('https://bill-chaser.test/api/webhooks/sinch', {
        method: 'POST',
        headers: { 'x-accountpulse-webhook-token': 'wrong-token' },
        body: JSON.stringify({
          event_type: 'REPLY',
          reply_id: randomUUID(),
          source_number: '+61400000003',
          destination_number: '+61400000004',
          received_date: '2026-09-18T01:02:03Z',
          content: 'This must not be accepted.'
        })
      })
    );

    expect(response.status).toBe(401);
    expect(queued).toHaveLength(before);
  });

  it('rejects a multibyte token without throwing', async () => {
    const handler = createSinchWebhookHandler({
      organisationId,
      publicKeys: new Map(),
      sharedToken: 'a'.repeat(32),
      repository: new PostgresWebhookRepository(client.db),
      queue
    });
    const response = await handler(
      new Request('https://bill-chaser.test/api/webhooks/sinch', {
        method: 'POST',
        headers: { 'x-accountpulse-webhook-token': 'é'.repeat(32) },
        body: '{}'
      })
    );
    expect(response.status).toBe(401);
  });

  it('verifies exact Retell bytes, records once, and queues protected processing', async () => {
    const callId = `retell-${randomUUID()}`;
    const body = `{
  "event": "call_started",
  "call": {
    "call_id": "${callId}",
    "call_status": "ongoing",
    "start_timestamp": ${retellNow.getTime()},
    "to_number": "+61412345678",
    "transcript": "private customer speech",
    "recording_url": "https://example.invalid/private.wav",
    "retell_llm_dynamic_variables": {
      "invoice_details_json": "private invoice details"
    }
  }
}`;
    const beforeQueued = queued.filter(
      (job) => (job.payload as { provider?: string }).provider === 'RETELL'
    ).length;
    const handler = createRetellWebhookHandler({
      organisationId,
      apiKey: retellApiKey,
      clock: { now: () => retellNow },
      repository: new PostgresWebhookRepository(client.db),
      queue
    });
    const request = () =>
      new Request('https://bill-chaser.test/api/webhooks/retell', {
        method: 'POST',
        headers: { 'x-retell-signature': retellSignature(body) },
        body
      });

    expect((await handler(request())).status).toBe(202);
    expect((await handler(request())).status).toBe(202);

    const matchingJobs = queued.filter(
      (job) =>
        (job.payload as { provider?: string }).provider === 'RETELL' &&
        job.singletonKey.includes(organisationId)
    );
    expect(matchingJobs).toHaveLength(beforeQueued + 1);
    expect(JSON.stringify(matchingJobs.at(-1))).not.toMatch(
      /private customer speech|private invoice details|private-retell-api-key|\+61412345678/
    );
    const stored = await client.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.organisationId, organisationId));
    const retellRows = stored.filter(
      (event) =>
        event.provider === 'RETELL' &&
        JSON.stringify(event.providerPayload).includes(callId)
    );
    expect(retellRows).toHaveLength(1);
    expect(retellRows[0]).toMatchObject({
      provider: 'RETELL',
      signatureValid: true
    });
    expect(retellRows[0]?.providerPayload).toEqual({ rawBody: body });
  });

  it('re-enqueues a stored Retell event when the first queue publish fails', async () => {
    const callId = `retell-retry-${randomUUID()}`;
    const body = JSON.stringify({
      event: 'call_started',
      call: {
        call_id: callId,
        call_status: 'ongoing',
        start_timestamp: retellNow.getTime()
      }
    });
    const enqueueUnique = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary queue failure'))
      .mockResolvedValueOnce('queued-after-retry');
    const handler = createRetellWebhookHandler({
      organisationId,
      apiKey: retellApiKey,
      clock: { now: () => retellNow },
      repository: new PostgresWebhookRepository(client.db),
      queue: { enqueueUnique }
    });
    const request = () =>
      new Request('https://bill-chaser.test/api/webhooks/retell', {
        method: 'POST',
        headers: { 'x-retell-signature': retellSignature(body) },
        body
      });

    await expect(handler(request())).rejects.toThrow('temporary queue failure');
    expect((await handler(request())).status).toBe(202);
    expect(enqueueUnique).toHaveBeenCalledTimes(2);
    expect(enqueueUnique.mock.calls[1]?.[1]).toMatchObject({
      organisationId,
      provider: 'RETELL'
    });
  });

  it.each([
    ['missing', '', retellNow],
    ['invalid', `v=${retellNow.getTime()},d=${'0'.repeat(64)}`, retellNow],
    [
      'stale',
      'signed',
      new Date(retellNow.getTime() + 5 * 60 * 1_000 + 1)
    ]
  ] as const)('rejects a %s Retell signature before recording', async (_name, signature, clockTime) => {
    const callId = `retell-rejected-${randomUUID()}`;
    const body = JSON.stringify({
      event: 'call_started',
      call: {
        call_id: callId,
        call_status: 'ongoing',
        start_timestamp: retellNow.getTime()
      }
    });
    const suppliedSignature =
      signature === 'signed' ? retellSignature(body) : signature;
    const beforeQueued = queued.length;
    const recordMetric = vi.fn();
    const handler = createRetellWebhookHandler({
      organisationId,
      apiKey: retellApiKey,
      clock: { now: () => clockTime },
      repository: new PostgresWebhookRepository(client.db),
      queue,
      recordMetric
    });

    const response = await handler(
      new Request('https://bill-chaser.test/api/webhooks/retell', {
        method: 'POST',
        headers: { 'x-retell-signature': suppliedSignature },
        body
      })
    );

    expect(response.status).toBe(401);
    expect(recordMetric).toHaveBeenCalledWith({
      metric: 'retell_webhook_signature_failures_total',
      value: 1,
      organisationId
    });
    expect(queued).toHaveLength(beforeQueued);
    const stored = await client.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.organisationId, organisationId));
    expect(JSON.stringify(stored)).not.toContain(callId);
  });
});
