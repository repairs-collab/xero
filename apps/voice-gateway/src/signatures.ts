import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type GatewayHttpMethod = 'GET' | 'POST';

export interface GatewaySignatureHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

interface GatewaySignatureBase {
  secret: string;
  method: GatewayHttpMethod;
  path: string;
  body: string;
  nonce: string;
}

export interface SignGatewayRequestInput extends GatewaySignatureBase {
  timestampMs: number;
}

export interface VerifyGatewayRequestInput extends GatewaySignatureBase {
  signature: string;
  timestamp: string;
  now: Date;
  toleranceMs?: number;
}

const signaturePattern = /^v1=([a-f0-9]{64})$/;
const noncePattern = /^[A-Za-z0-9._:-]{16,128}$/;
const defaultToleranceMs = 5 * 60 * 1_000;

const canonicalBytes = (input: {
  method: GatewayHttpMethod;
  path: string;
  body: string;
  timestamp: string;
  nonce: string;
}): string =>
  [
    'v1',
    input.timestamp,
    input.nonce,
    input.method,
    input.path,
    createHash('sha256').update(input.body, 'utf8').digest('hex')
  ].join('\n');

export const signGatewayRequest = (
  input: SignGatewayRequestInput
): GatewaySignatureHeaders => {
  if (
    input.secret.length === 0 ||
    !Number.isSafeInteger(input.timestampMs) ||
    !noncePattern.test(input.nonce) ||
    !input.path.startsWith('/')
  ) {
    throw new Error('GATEWAY_SIGNATURE_INPUT_INVALID');
  }
  const timestamp = String(input.timestampMs);
  const digest = createHmac('sha256', input.secret)
    .update(canonicalBytes({ ...input, timestamp }))
    .digest('hex');
  return { timestamp, nonce: input.nonce, signature: `v1=${digest}` };
};

export const verifyGatewayRequest = (
  input: VerifyGatewayRequestInput
): boolean => {
  const match = signaturePattern.exec(input.signature);
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? defaultToleranceMs;
  if (
    match === null ||
    input.secret.length === 0 ||
    !noncePattern.test(input.nonce) ||
    !input.path.startsWith('/') ||
    !Number.isSafeInteger(timestampMs) ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isFinite(toleranceMs) ||
    toleranceMs < 0 ||
    Math.abs(input.now.getTime() - timestampMs) > toleranceMs
  ) {
    return false;
  }
  const digest = match[1];
  if (digest === undefined) return false;
  const expected = createHmac('sha256', input.secret)
    .update(canonicalBytes({ ...input, timestamp: input.timestamp }))
    .digest();
  const supplied = Buffer.from(digest, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

export class InMemoryReplayProtector {
  private readonly nonces = new Map<string, number>();

  constructor(private readonly retentionMs = defaultToleranceMs) {}

  claim(nonce: string, now: Date): boolean {
    const nowMs = now.getTime();
    for (const [storedNonce, claimedAt] of this.nonces) {
      if (claimedAt < nowMs - this.retentionMs) this.nonces.delete(storedNonce);
    }
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, nowMs);
    return true;
  }
}
