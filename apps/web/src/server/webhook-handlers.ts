import { timingSafeEqual } from 'node:crypto';

import type { WebhookRepository } from '@bc5000/db/web';
import {
  parseRetellWebhook,
  verifyRetellWebhook
} from '@bc5000/integrations/retell';
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
      provider: 'XERO' | 'SINCH' | 'RETELL';
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
  organisationId: string,
  provider: 'XERO' | 'SINCH' | 'RETELL',
  eventId: string,
  rawBody: Uint8Array
): Promise<void> => {
  const recorded = await dependencies.repository.recordOnceWithId({
    organisationId,
    provider,
    providerEventId: eventId,
    rawBody: Buffer.from(rawBody).toString('utf8'),
    signatureValid: true
  });
  await dependencies.queue.enqueueUnique(
    jobNames.webhookProcess,
    {
      organisationId,
      webhookEventId: recorded.id,
      provider
    },
    `webhook:${provider}:${organisationId}:${eventId}`
  );
};

export function createXeroWebhookHandler(
  dependencies: Omit<CommonDependencies, 'organisationId'> & {
    webhookKey: string;
    resolveOrganisationId(tenantId: string): Promise<string | null>;
    recordUnknownTenant?(tenantId: string): void;
  }
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
    let ignoredTenants = 0;
    for (const event of parsed.accepted) {
      const organisationId = await dependencies.resolveOrganisationId(
        event.tenantId
      );
      if (organisationId === null) {
        ignoredTenants += 1;
        dependencies.recordUnknownTenant?.(event.tenantId);
        continue;
      }
      const eventId = `${event.resourceId}:${event.eventType}:${event.eventDateUtc}`;
      await enqueueRecorded(
        { ...dependencies, organisationId },
        organisationId,
        'XERO',
        eventId,
        rawBody
      );
    }
    if (ignoredTenants === 0) return new Response('', { status: 200 });
    return new Response('', {
      status: 200,
      headers: { 'x-accountpulse-ignored-tenants': String(ignoredTenants) }
    });
  };
}

export function createSinchWebhookHandler(
  dependencies: Omit<CommonDependencies, 'organisationId'> & {
    organisationId?: string;
    resolveOrganisationId?(destinationNumber: string): Promise<string | null>;
    resolveDeliveryOrganisationId?(messageId: string): Promise<string | null>;
    resolveLegacyOrganisationId?(candidateId: string): Promise<string | null>;
    publicKeys: ReadonlyMap<string, string | Buffer>;
    sharedToken: string;
  }
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rawBody = await byteBody(request);
    const url = new URL(request.url);
    const suppliedToken =
      request.headers.get('x-accountpulse-webhook-token') ?? '';
    const expectedToken = dependencies.sharedToken;
    const suppliedTokenBytes = Buffer.from(suppliedToken, 'utf8');
    const expectedTokenBytes = Buffer.from(expectedToken, 'utf8');
    const tokenVerified =
      suppliedTokenBytes.length === expectedTokenBytes.length &&
      suppliedTokenBytes.length > 0 &&
      timingSafeEqual(suppliedTokenBytes, expectedTokenBytes);
    const signatureVerified = await verifySinchCallback({
      requestLine: `${request.method} ${url.pathname}${url.search} HTTP/1.1`,
      date: request.headers.get('date') ?? '',
      rawBody,
      signatureBase64:
        request.headers.get('x-messagemedia-signature') ?? '',
      digest:
        request.headers.get('x-messagemedia-digest-type') ?? '',
      cipher:
        request.headers.get('x-messagemedia-cipher-type') ?? '',
      keyId:
        request.headers.get('x-messagemedia-key-id') ?? '',
      publicKeys: dependencies.publicKeys
    });
    if (!tokenVerified && !signatureVerified) {
      return new Response('', { status: 401 });
    }

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
    const destinationNumber =
      event.kind === 'reply' || event.kind === 'opt-out' ? event.to : null;
    let resolvedOrganisationId: string | null = null;
    if (
      typeof destinationNumber === 'string' &&
      dependencies.resolveOrganisationId !== undefined
    ) {
      resolvedOrganisationId =
        await dependencies.resolveOrganisationId(destinationNumber);
    }
    if (
      resolvedOrganisationId === null &&
      typeof event.messageId === 'string' &&
      dependencies.resolveDeliveryOrganisationId !== undefined
    ) {
      resolvedOrganisationId =
        await dependencies.resolveDeliveryOrganisationId(event.messageId);
    }
    if (
      resolvedOrganisationId === null &&
      event.kind === 'reply' &&
      dependencies.resolveLegacyOrganisationId !== undefined &&
      typeof event.metadata.organisationId === 'string'
    ) {
      resolvedOrganisationId = await dependencies.resolveLegacyOrganisationId(
        event.metadata.organisationId
      );
    }
    if (
      resolvedOrganisationId === null &&
      dependencies.resolveOrganisationId === undefined &&
      dependencies.resolveDeliveryOrganisationId === undefined
    ) {
      resolvedOrganisationId = dependencies.organisationId ?? null;
    }
    if (resolvedOrganisationId === null) {
      return new Response('', {
        status: 202,
        headers: { 'x-accountpulse-ignored-destination': 'true' }
      });
    }
    await enqueueRecorded(
      { ...dependencies, organisationId: resolvedOrganisationId },
      resolvedOrganisationId,
      'SINCH',
      eventId,
      rawBody
    );
    return new Response('', { status: 202 });
  };
}

export function createRetellWebhookHandler(
  dependencies: CommonDependencies & {
    apiKey: string;
    clock: { now(): Date };
    recordMetric?: (metric: {
      metric: 'retell_webhook_signature_failures_total';
      value: 1;
      organisationId: string;
    }) => void;
  }
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rawBody = await byteBody(request);
    const signature = request.headers.get('x-retell-signature') ?? '';
    if (
      !verifyRetellWebhook({
        rawBody,
        signature,
        apiKey: dependencies.apiKey,
        now: dependencies.clock.now()
      })
    ) {
      const metric = {
        metric: 'retell_webhook_signature_failures_total' as const,
        value: 1 as const,
        organisationId: dependencies.organisationId
      };
      if (dependencies.recordMetric) dependencies.recordMetric(metric);
      else console.warn('AccountPulse operational metric', metric);
      return new Response('', { status: 401 });
    }

    let event;
    try {
      event = parseRetellWebhook(rawBody);
    } catch {
      return new Response('', { status: 400 });
    }
    await enqueueRecorded(
      dependencies,
      dependencies.organisationId,
      'RETELL',
      event.eventKey,
      rawBody
    );
    return new Response('', { status: 202 });
  };
}
