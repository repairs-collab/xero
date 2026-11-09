import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AcceptedXeroInvoiceEvent {
  tenantId: string;
  resourceId: string;
  eventType: 'CREATE' | 'UPDATE';
  eventDateUtc: string;
}

export interface IgnoredXeroEvent {
  resourceId: string;
  reason: 'MISSING_TENANT_ID' | 'UNSUPPORTED_CATEGORY_OR_EVENT';
}

export interface ParsedXeroWebhook {
  accepted: AcceptedXeroInvoiceEvent[];
  ignored: IgnoredXeroEvent[];
}

export class XeroWebhookSignatureError extends Error {
  constructor() {
    super('Invalid Xero webhook signature');
    this.name = 'XeroWebhookSignatureError';
  }
}

export function verifyXeroWebhook(
  rawBody: Uint8Array,
  signature: string,
  webhookKey: string
): boolean {
  const expected = createHmac('sha256', webhookKey)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(signature, 'base64');
  return (
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  );
}

interface RawXeroWebhookEvent {
  tenantId?: unknown;
  resourceId?: unknown;
  eventCategory?: unknown;
  eventType?: unknown;
  eventDateUtc?: unknown;
}

interface RawXeroWebhook {
  events?: unknown;
}

export function parseVerifiedXeroWebhook(
  rawBody: Uint8Array,
  signature: string,
  webhookKey: string
): ParsedXeroWebhook {
  if (!verifyXeroWebhook(rawBody, signature, webhookKey)) {
    throw new XeroWebhookSignatureError();
  }

  const payload = JSON.parse(Buffer.from(rawBody).toString('utf8')) as
    RawXeroWebhook;
  if (!Array.isArray(payload.events)) {
    throw new Error('Malformed Xero webhook payload');
  }

  const accepted: AcceptedXeroInvoiceEvent[] = [];
  const ignored: IgnoredXeroEvent[] = [];

  for (const rawEvent of payload.events as RawXeroWebhookEvent[]) {
    const resourceId =
      typeof rawEvent.resourceId === 'string'
        ? rawEvent.resourceId
        : 'unknown';
    if (
      rawEvent.eventCategory === 'INVOICE' &&
      (rawEvent.eventType === 'CREATE' ||
        rawEvent.eventType === 'UPDATE') &&
      typeof rawEvent.eventDateUtc === 'string'
    ) {
      if (
        typeof rawEvent.tenantId !== 'string' ||
        rawEvent.tenantId.length === 0
      ) {
        ignored.push({ resourceId, reason: 'MISSING_TENANT_ID' });
      } else {
        accepted.push({
          tenantId: rawEvent.tenantId,
          resourceId,
          eventType: rawEvent.eventType,
          eventDateUtc: rawEvent.eventDateUtc
        });
      }
    } else {
      ignored.push({
        resourceId,
        reason: 'UNSUPPORTED_CATEGORY_OR_EVENT'
      });
    }
  }

  return { accepted, ignored };
}

export function evaluateXeroWebhook(
  rawBody: Uint8Array,
  signature: string,
  webhookKey: string
): { status: 200 | 401; body: '' } {
  return verifyXeroWebhook(rawBody, signature, webhookKey)
    ? { status: 200, body: '' }
    : { status: 401, body: '' };
}
