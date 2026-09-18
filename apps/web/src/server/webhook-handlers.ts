import type { WebhookRepository } from '@bc5000/db/web';
import {
  parseSinchEvent,
  verifySinchCallback
} from '@bc5000/integrations/sinch';
import {
  parseVerifiedXeroWebhook,
  verifyXeroWebhook
} from '@bc5000/integrations/xero';
import { jobNames } from '@bc5000/jobs';

interface WebhookQueue {
  enqueueUnique(
    name: typeof jobNames.webhookProcess,
    payload: {
      organisationId: string;
      webhookEventId: string;
      provider: 'XERO' | 'SINCH';
    },
    singletonKey: string
  ): Promise<string>;
}

interface CommonDependencies {
  organisationId: string;
  repository: WebhookRepository;
  queue: WebhookQueue;
}

const byteBody = async (request: Request): Promise<Uint8Array> =>
  new Uint8Array(await request.arrayBuffer());

const enqueueRecorded = async (
  dependencies: CommonDependencies,
  provider: 'XERO' | 'SINCH',
  eventId: string,
  rawBody: Uint8Array
): Promise<void> => {
  const recorded = await dependencies.repository.recordOnceWithId({
    organisationId: dependencies.organisationId,
    provider,
    providerEventId: eventId,
    rawBody: Buffer.from(rawBody).toString('utf8'),
    signatureValid: true
  });
  if (recorded.kind === 'duplicate') return;
  await dependencies.queue.enqueueUnique(
    jobNames.webhookProcess,
    {
      organisationId: dependencies.organisationId,
      webhookEventId: recorded.id,
      provider
    },
    `webhook:${provider}:${dependencies.organisationId}:${eventId}`
  );
};

export function createXeroWebhookHandler(
  dependencies: CommonDependencies & { webhookKey: string }
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rawBody = await byteBody(request);
    const signature = request.headers.get('x-xero-signature') ?? '';
    if (!verifyXeroWebhook(rawBody, signature, dependencies.webhookKey)) {
      return new Response('', { status: 401 });
    }
    let parsed;
    try {
      parsed = parseVerifiedXeroWebhook(
        rawBody,
        signature,
        dependencies.webhookKey
      );
    } catch {
      return new Response('', { status: 400 });
    }
    for (const event of parsed.accepted) {
      const eventId = `${event.resourceId}:${event.eventType}:${event.eventDateUtc}`;
      await enqueueRecorded(dependencies, 'XERO', eventId, rawBody);
    }
    return new Response('', { status: 200 });
  };
}

export function createSinchWebhookHandler(
  dependencies: CommonDependencies & {
    publicKeys: ReadonlyMap<string, string | Buffer>;
  }
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rawBody = await byteBody(request);
    const url = new URL(request.url);
    const verified = await verifySinchCallback({
      requestLine: `${request.method} ${url.pathname}${url.search} HTTP/1.1`,
      date: request.headers.get('date') ?? '',
      rawBody,
      signatureBase64: request.headers.get('x-sinch-signature') ?? '',
      digest: request.headers.get('x-sinch-digest') ?? '',
      cipher: request.headers.get('x-sinch-cipher') ?? '',
      keyId: request.headers.get('x-sinch-key-id') ?? '',
      publicKeys: dependencies.publicKeys
    });
    if (!verified) return new Response('', { status: 401 });

    let event;
    try {
      event = parseSinchEvent(rawBody);
    } catch {
      return new Response('', { status: 400 });
    }
    const eventId =
      event.kind === 'delivery'
        ? `${event.messageId}:${event.status}:${event.occurredAt}`
        : event.kind === 'reply'
          ? event.replyId
          : event.notificationId;
    await enqueueRecorded(dependencies, 'SINCH', eventId, rawBody);
    return new Response('', { status: 202 });
  };
}
