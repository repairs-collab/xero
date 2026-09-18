import { verify } from 'node:crypto';

import type {
  SinchDeliveryEvent,
  SinchEvent,
  SinchOptOutEvent,
  SinchReplyEvent
} from './types.js';

export type SinchDigest = 'SHA-224' | 'SHA-256' | 'SHA-512';

export interface VerifySinchCallbackInput {
  requestLine: string;
  date: string;
  rawBody: Uint8Array;
  signatureBase64: string;
  digest: string;
  cipher: string;
  keyId: string;
  publicKeys: ReadonlyMap<string, string | Buffer>;
}

export function sinchCallbackCanonicalBytes(
  requestLine: string,
  date: string,
  rawBody: Uint8Array
): Buffer {
  return Buffer.concat([
    Buffer.from(`${requestLine}\n${date}\n`, 'utf8'),
    Buffer.from(rawBody)
  ]);
}

const digestAlgorithm = (digest: SinchDigest): string =>
  `RSA-${digest.replace('-', '')}`;

export function verifySinchCallback(
  input: VerifySinchCallbackInput
): Promise<boolean> {
  if (input.cipher !== 'RSA') return Promise.resolve(false);
  if (
    input.digest !== 'SHA-224' &&
    input.digest !== 'SHA-256' &&
    input.digest !== 'SHA-512'
  ) {
    return Promise.resolve(false);
  }
  const publicKey = input.publicKeys.get(input.keyId);
  if (publicKey === undefined) return Promise.resolve(false);

  try {
    return Promise.resolve(
      verify(
        digestAlgorithm(input.digest),
        sinchCallbackCanonicalBytes(
          input.requestLine,
          input.date,
          input.rawBody
        ),
        publicKey,
        Buffer.from(input.signatureBase64, 'base64')
      )
    );
  } catch {
    return Promise.resolve(false);
  }
}

type JsonRecord = Record<string, unknown>;

const parseRecord = (rawBody: Uint8Array): JsonRecord => {
  const parsed = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Malformed Sinch webhook payload');
  }
  return parsed as JsonRecord;
};

const requiredString = (payload: JsonRecord, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing Sinch webhook field: ${key}`);
  }
  return value;
};

const optionalString = (
  payload: JsonRecord,
  key: string
): string | undefined => {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const metadataFrom = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
};

const deliveryCategory = (
  status: string
): SinchDeliveryEvent['category'] => {
  if (status === 'DELIVERED') return 'delivered';
  if (
    status === 'REJECTED' ||
    status === 'FAILED' ||
    status === 'UNDELIVERABLE' ||
    status === 'EXPIRED'
  ) {
    return 'permanently-failed';
  }
  return 'nonterminal';
};

const parseReply = (payload: JsonRecord): SinchReplyEvent => {
  const event: SinchReplyEvent = {
    kind: 'reply',
    replyId: requiredString(payload, 'reply_id'),
    from: requiredString(payload, 'source_number'),
    to: requiredString(payload, 'destination_number'),
    receivedAt: requiredString(payload, 'received_date'),
    content: requiredString(payload, 'content'),
    metadata: metadataFrom(payload.metadata)
  };
  const messageId = optionalString(payload, 'message_id');
  if (messageId !== undefined) event.messageId = messageId;
  return event;
};

const parseOptOut = (payload: JsonRecord): SinchOptOutEvent => {
  const event: SinchOptOutEvent = {
    kind: 'opt-out',
    notificationId: requiredString(payload, 'notification_id'),
    from: requiredString(payload, 'source_number'),
    to: requiredString(payload, 'destination_number'),
    receivedAt: requiredString(payload, 'received_date'),
    content: requiredString(payload, 'content')
  };
  const messageId = optionalString(payload, 'message_id');
  if (messageId !== undefined) event.messageId = messageId;
  return event;
};

const parseDelivery = (payload: JsonRecord): SinchDeliveryEvent => {
  const status = requiredString(payload, 'status');
  const statusCode = payload.status_code;
  if (typeof statusCode !== 'number') {
    throw new Error('Missing Sinch webhook field: status_code');
  }
  return {
    kind: 'delivery',
    messageId: requiredString(payload, 'message_id'),
    status,
    statusCode,
    category: deliveryCategory(status),
    occurredAt: requiredString(payload, 'timestamp'),
    metadata: metadataFrom(payload.metadata)
  };
};

export function parseSinchEvent(rawBody: Uint8Array): SinchEvent {
  const payload = parseRecord(rawBody);
  const eventType = requiredString(payload, 'event_type');
  if (eventType === 'REPLY') return parseReply(payload);
  if (eventType === 'OPT_OUT') return parseOptOut(payload);
  if (eventType === 'DELIVERY_REPORT') return parseDelivery(payload);
  throw new Error(`Unsupported Sinch event type: ${eventType}`);
}
