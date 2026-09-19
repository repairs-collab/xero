import {
  createHmac,
  createSign,
  generateKeyPairSync,
  randomUUID
} from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
});
