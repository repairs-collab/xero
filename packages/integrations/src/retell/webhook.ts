import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { parseRetellCallStatus } from './client.js';
import type {
  RetellWebhookEvent,
  RetellWebhookEventType
} from './types.js';

const defaultToleranceMs = 5 * 60 * 1_000;
const signaturePattern = /^v=(\d+),d=([a-fA-F0-9]{64})$/;
const supportedEvents = new Set<RetellWebhookEventType>([
  'call_started',
  'call_ended',
  'call_analyzed'
]);

export interface VerifyRetellWebhookInput {
  rawBody: Uint8Array;
  signature: string;
  apiKey: string;
  now: Date;
  toleranceMs?: number;
}

export const verifyRetellWebhook = (
  input: VerifyRetellWebhookInput
): boolean => {
  const match = signaturePattern.exec(input.signature);
  if (match === null || input.apiKey.length === 0) return false;
  const timestampText = match[1];
  const digestText = match[2];
  if (timestampText === undefined || digestText === undefined) return false;

  const timestamp = Number(timestampText);
  const toleranceMs = input.toleranceMs ?? defaultToleranceMs;
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isFinite(toleranceMs) ||
    toleranceMs < 0 ||
    Math.abs(input.now.getTime() - timestamp) > toleranceMs
  ) {
    return false;
  }

  const expected = createHmac('sha256', input.apiKey)
    .update(input.rawBody)
    .update(timestampText)
    .digest();
  const supplied = Buffer.from(digestText, 'hex');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const eventTimestamp = (
  eventType: RetellWebhookEventType,
  call: Record<string, unknown>
): number | 'missing' => {
  const preferred =
    eventType === 'call_started'
      ? call.start_timestamp
      : call.end_timestamp ?? call.start_timestamp;
  return typeof preferred === 'number' && Number.isFinite(preferred)
    ? preferred
    : 'missing';
};

export const parseRetellWebhook = (
  rawBody: Uint8Array
): RetellWebhookEvent => {
  let payload: Record<string, unknown>;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    const candidate = asRecord(JSON.parse(decoded));
    if (candidate === null) throw new Error('not an object');
    payload = candidate;
  } catch {
    throw new Error('RETELL_WEBHOOK_INVALID_JSON');
  }

  if (
    typeof payload.event !== 'string' ||
    !supportedEvents.has(payload.event as RetellWebhookEventType)
  ) {
    throw new Error('RETELL_WEBHOOK_EVENT_UNSUPPORTED');
  }
  const eventType = payload.event as RetellWebhookEventType;
  const call = asRecord(payload.call);
  if (call === null) throw new Error('RETELL_WEBHOOK_INVALID_CALL');

  let status;
  try {
    status = parseRetellCallStatus(call);
  } catch {
    throw new Error('RETELL_WEBHOOK_INVALID_CALL');
  }
  const eventKey = createHash('sha256')
    .update(eventType)
    .update('\0')
    .update(status.callId)
    .update('\0')
    .update(String(eventTimestamp(eventType, call)))
    .digest('hex');

  return {
    eventType,
    eventKey: `retell:${eventKey}`,
    ...status
  };
};
