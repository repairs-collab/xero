import { and, eq, sql } from 'drizzle-orm';

import {
  type Database,
  webhookEvents
} from '@bc5000/db';
import { parseSinchEvent } from '@bc5000/integrations/sinch';
import {
  jobNames,
  type JobPayloads,
  type JobPublisher
} from '@bc5000/jobs';

import { processDeliveryEvent } from '../services/delivery-service.js';
import {
  processInboundReply,
  processOptOut
} from '../services/inbound-reply-service.js';

export interface WebhookProcessDependencies {
  database: Database;
  publisher: JobPublisher;
}

type JsonRecord = Record<string, unknown>;

const rawBodyFrom = (payload: Record<string, unknown>): string => {
  const rawBody = payload.rawBody;
  if (typeof rawBody !== 'string') {
    throw new Error('Stored webhook has no raw body');
  }
  return rawBody;
};

const parseRecord = (rawBody: string): JsonRecord => {
  const parsed = JSON.parse(rawBody) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Stored webhook payload is malformed');
  }
  return parsed as JsonRecord;
};

const processXeroEvent = async (
  dependencies: WebhookProcessDependencies,
  event: typeof webhookEvents.$inferSelect,
  rawBody: string
): Promise<void> => {
  const payload = parseRecord(rawBody);
  if (!Array.isArray(payload.events)) {
    throw new Error('Stored Xero webhook has no events');
  }
  const matching = (payload.events as JsonRecord[]).find((candidate) => {
    if (
      typeof candidate.resourceId !== 'string' ||
      typeof candidate.eventType !== 'string' ||
      typeof candidate.eventDateUtc !== 'string'
    ) {
      return false;
    }
    return (
      `${candidate.resourceId}:${candidate.eventType}:${candidate.eventDateUtc}` ===
      event.providerEventId
    );
  });
  if (matching === undefined || typeof matching.resourceId !== 'string') {
    throw new Error('Stored Xero event could not be matched');
  }
  await dependencies.publisher.publish(
    jobNames.xeroInvoiceRefresh,
    {
      organisationId: event.organisationId,
      invoiceId: matching.resourceId,
      webhookEventId: event.id
    },
    {
      singletonKey: `xero.invoice-refresh:${event.organisationId}:${matching.resourceId}:${event.id}`
    }
  );
};

export async function processWebhookEvent(
  dependencies: WebhookProcessDependencies,
  payload: JobPayloads['webhook.process']
): Promise<void> {
  const [stored] = await dependencies.database
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.organisationId, payload.organisationId),
        eq(webhookEvents.id, payload.webhookEventId),
        eq(webhookEvents.provider, payload.provider)
      )
    )
    .limit(1);
  if (stored === undefined) throw new Error('Webhook event was not found');
  if (stored.processedAt !== null) return;
  if (!stored.signatureValid) throw new Error('Refusing an unverified webhook');

  await dependencies.database
    .update(webhookEvents)
    .set({
      processingAttempts: sql`${webhookEvents.processingAttempts} + 1`,
      processingError: null
    })
    .where(eq(webhookEvents.id, stored.id));

  try {
    const rawBody = rawBodyFrom(stored.providerPayload);
    if (stored.provider === 'XERO') {
      await processXeroEvent(dependencies, stored, rawBody);
    } else {
      const event = parseSinchEvent(Buffer.from(rawBody));
      const providerPayload = parseRecord(rawBody);
      if (event.kind === 'reply') {
        await processInboundReply(
          dependencies.database,
          stored.organisationId,
          event,
          providerPayload
        );
      } else if (event.kind === 'opt-out') {
        await processOptOut(
          dependencies.database,
          stored.organisationId,
          event
        );
      } else {
        await processDeliveryEvent(
          dependencies.database,
          stored.organisationId,
          event
        );
      }
    }
    await dependencies.database
      .update(webhookEvents)
      .set({ processedAt: new Date(), processingError: null })
      .where(eq(webhookEvents.id, stored.id));
  } catch (error) {
    await dependencies.database
      .update(webhookEvents)
      .set({
        processingError:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : 'Unknown webhook processing error'
      })
      .where(eq(webhookEvents.id, stored.id));
    throw error;
  }
}
