import { describe, expect, it } from 'vitest';

import {
  signGatewayRequest,
  verifyGatewayRequest
} from '../src/signatures.js';

const baseInput = {
  secret: 'gateway-signing-secret',
  method: 'POST' as const,
  path: '/v1/calls',
  body: '{"gatewayCallId":"11111111-1111-4111-8111-111111111111"}',
  timestampMs: 1791511200000,
  nonce: 'nonce-000000000001'
};

describe('gateway request signatures', () => {
  it('verifies an intact body with a timestamp inside the allowed window', () => {
    const headers = signGatewayRequest(baseInput);
    expect(
      verifyGatewayRequest({
        ...baseInput,
        signature: headers.signature,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        now: new Date(baseInput.timestampMs + 10_000)
      })
    ).toBe(true);
  });

  it('rejects body, method, path, timestamp, nonce, and signature tampering', () => {
    const headers = signGatewayRequest(baseInput);
    const verify = (overrides: Record<string, unknown>) =>
      verifyGatewayRequest({
        ...baseInput,
        signature: headers.signature,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        now: new Date(baseInput.timestampMs),
        ...overrides
      });

    expect(verify({ body: '{"tampered":true}' })).toBe(false);
    expect(verify({ method: 'GET' })).toBe(false);
    expect(verify({ path: '/v1/calls/other' })).toBe(false);
    expect(verify({ timestamp: String(baseInput.timestampMs + 1) })).toBe(false);
    expect(verify({ nonce: 'nonce-000000000002' })).toBe(false);
    expect(verify({ signature: 'v1=not-a-valid-digest' })).toBe(false);
  });

  it('rejects stale or future timestamps and an empty secret', () => {
    const headers = signGatewayRequest(baseInput);
    expect(
      verifyGatewayRequest({
        ...baseInput,
        signature: headers.signature,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        now: new Date(baseInput.timestampMs + 300_001)
      })
    ).toBe(false);
    expect(
      verifyGatewayRequest({
        ...baseInput,
        signature: headers.signature,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        now: new Date(baseInput.timestampMs - 300_001)
      })
    ).toBe(false);
    expect(
      verifyGatewayRequest({
        ...baseInput,
        secret: '',
        signature: headers.signature,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        now: new Date(baseInput.timestampMs)
      })
    ).toBe(false);
  });
});
