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

const accountFrom = (payload: JsonRecord): string | undefined => {
  const accountId = optionalString(payload, 'account_id');
  const vendorAccount = payload.vendor_account_id;
  const vendorAccountId =
    typeof vendorAccount === 'object' && vendorAccount !== null
      ? optionalString(vendorAccount as JsonRecord, 'account_id')
      : undefined;
  if (
    accountId !== undefined &&
    vendorAccountId !== undefined &&
    accountId !== vendorAccountId
  ) {
    throw new Error('Conflicting Sinch provider accounts');
  }
  return accountId ?? vendorAccountId;
};

const inboundFields = (payload: JsonRecord) => {
  const accountId = accountFrom(payload);
  const to = optionalString(payload, 'destination_number');
  const messageId = optionalString(payload, 'message_id');
  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(to === undefined ? {} : { to }),
    ...(messageId === undefined ? {} : { messageId }),
    from: requiredString(payload, 'source_number'),
    receivedAt:
      optionalString(payload, 'received_date') ??
      requiredString(payload, 'date_received'),
    content: requiredString(payload, 'content')
  };
};

const deliveryCategory = (
  status: string
): SinchDeliveryEvent['category'] => {
  const normalised = status.toUpperCase();
  if (normalised === 'DELIVERED') return 'delivered';
  if (
    normalised === 'REJECTED' ||
    normalised === 'FAILED' ||
    normalised === 'UNDELIVERABLE' ||
    normalised === 'EXPIRED'
  ) {
    return 'permanently-failed';
  }
  return 'nonterminal';
};

export const parseSinchReply = (payload: JsonRecord): SinchReplyEvent => {
  return {
    kind: 'reply',
    replyId: requiredString(payload, 'reply_id'),
    ...inboundFields(payload),
    metadata: metadataFrom(payload.metadata)
  };
};

const parseOptOut = (payload: JsonRecord): SinchOptOutEvent => {
  return {
    kind: 'opt-out',
    notificationId: requiredString(payload, 'notification_id'),
    ...inboundFields(payload),
    ...(payload.metadata === undefined
      ? {}
      : { metadata: metadataFrom(payload.metadata) })
  };
};

const parseDelivery = (payload: JsonRecord): SinchDeliveryEvent => {
  const status = requiredString(payload, 'status');
  const accountId = accountFrom(payload);
  const from = optionalString(payload, 'source_number');
  const rawStatusCode = payload.status_code ?? payload.error_code;
  const statusCode =
    typeof rawStatusCode === 'number'
      ? rawStatusCode
      : typeof rawStatusCode === 'string' && /^-?\d+$/.test(rawStatusCode)
        ? Number(rawStatusCode)
        : Number.NaN;
  if (!Number.isSafeInteger(statusCode)) {
    throw new Error('Missing Sinch webhook field: status_code');
  }
  return {
    kind: 'delivery',
    ...(accountId === undefined ? {} : { accountId }),
    ...(from === undefined ? {} : { from }),
    messageId: requiredString(payload, 'message_id'),
    status,
    statusCode,
    category: deliveryCategory(status),
    occurredAt:
      optionalString(payload, 'timestamp') ??
      requiredString(payload, 'date_received'),
    metadata: metadataFrom(payload.metadata)
  };
};

export function parseSinchEvent(rawBody: Uint8Array): SinchEvent {
  const payload = parseRecord(rawBody);
  const eventType = payload.event_type;
  if (eventType === 'REPLY') return parseSinchReply(payload);
  if (eventType === 'OPT_OUT') return parseOptOut(payload);
  if (eventType === 'DELIVERY_REPORT') return parseDelivery(payload);
  if (eventType === undefined) {
    if (typeof payload.reply_id === 'string') return parseSinchReply(payload);
    if (typeof payload.notification_id === 'string') return parseOptOut(payload);
    if (typeof payload.delivery_report_id === 'string') return parseDelivery(payload);
  }
  throw new Error('Unsupported Sinch event type');
}
