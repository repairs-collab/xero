import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signGatewayRequest } from '../src/signatures.js';
import {
  InMemoryGatewaySessionStore,
  type GatewaySessionStore
} from '../src/session-store.js';
import { createGatewayServer } from '../src/server.js';

const secret = 'gateway-signing-secret';
const now = new Date('2026-10-09T00:00:00.000Z');

const command = {
  version: 1 as const,
  gatewayCallId: '11111111-1111-4111-8111-111111111111',
  organisationId: '22222222-2222-4222-8222-222222222222',
  voiceCallId: '33333333-3333-4333-8333-333333333333',
  idempotencyKey: 'voice-call-1',
  provider: 'VOIPCLOUD' as const,
  providerUserNumber: '1010',
  destinationNumber: '+61400000001',
  callerId: '+61350324518',
  flowVersion: 1,
  ttsVoiceId: 'en_AU-sample-medium',
  callbackUrl: 'http://web:3000/api/internal/voice-gateway/events',
  transfer: {
    sipUri: 'sip:accounts@voipcloud.invalid',
    fallbackNumber: '+61350324518',
    label: 'Main office accounts queue'
  },
  approvedFacts: {
    accountName: 'Sample Customer Pty Ltd',
    combinedAmount: '120.50',
    currency: 'AUD',
    invoices: [
      {
        invoiceNumber: 'INV-1001',
        amountDue: '120.50',
        dueDate: '2026-09-01'
      }
    ]
  }
};

describe('voice gateway control server', () => {
  let store: GatewaySessionStore;
  let server: ReturnType<typeof createGatewayServer>;
  let baseUrl: string;
  let nonceCounter: number;

  beforeEach(async () => {
    store = new InMemoryGatewaySessionStore();
    nonceCounter = 0;
    server = createGatewayServer({
      store,
      signingSecret: secret,
      clock: { now: () => new Date(now) },
      supportedFlowVersion: 1
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  const request = async (
    path: string,
    options: {
      method?: 'GET' | 'POST';
      body?: string;
      nonce?: string;
      secretOverride?: string;
    } = {}
  ) => {
    const method = options.method ?? 'GET';
    const body = options.body ?? '';
    nonceCounter += 1;
    const signed = signGatewayRequest({
      secret: options.secretOverride ?? secret,
      method,
      path,
      body,
      timestampMs: now.getTime(),
      nonce: options.nonce ?? `nonce-${String(nonceCounter).padStart(16, '0')}`
    });
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-accountpulse-timestamp': signed.timestamp,
        'x-accountpulse-nonce': signed.nonce,
        'x-accountpulse-signature': signed.signature
      },
      ...(body === '' ? {} : { body })
    });
  };

  it('requires authentication for readiness and reports safe readiness only', async () => {
    const unsigned = await fetch(`${baseUrl}/health/ready`);
    expect(unsigned.status).toBe(401);

    const response = await request('/health/ready');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ready: true, version: 1 });
  });

  it('creates a minimal session and returns it without protected facts', async () => {
    const body = JSON.stringify(command);
    const response = await request('/v1/calls', { method: 'POST', body });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      gatewayCallId: command.gatewayCallId,
      state: 'PENDING',
      created: true
    });

    const statusResponse = await request(`/v1/calls/${command.gatewayCallId}`);
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json();
    expect(status).toMatchObject({
      gatewayCallId: command.gatewayCallId,
      organisationId: command.organisationId,
      voiceCallId: command.voiceCallId,
      providerUserNumber: command.providerUserNumber,
      state: 'PENDING',
      lastEventSequence: 0
    });
    expect(JSON.stringify(status)).not.toMatch(
      /Sample Customer|INV-1001|120\.50|61400000001|approvedFacts|destinationNumber/i
    );
  });

  it('returns the same session for the same idempotency key and command', async () => {
    const body = JSON.stringify(command);
    expect((await request('/v1/calls', { method: 'POST', body })).status).toBe(201);
    const repeated = await request('/v1/calls', { method: 'POST', body });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({
      gatewayCallId: command.gatewayCallId,
      state: 'PENDING',
      created: false
    });
  });

  it('starts a newly persisted call once and never dispatches an idempotent retry', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    const startCall = vi.fn().mockResolvedValue(undefined);
    server = createGatewayServer({
      store,
      signingSecret: secret,
      clock: { now: () => new Date(now) },
      supportedFlowVersion: 1,
      startCall
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const body = JSON.stringify(command);
    expect((await request('/v1/calls', { method: 'POST', body })).status).toBe(201);
    expect((await request('/v1/calls', { method: 'POST', body })).status).toBe(200);
    expect(startCall).toHaveBeenCalledTimes(1);
    expect(startCall).toHaveBeenCalledWith(command);
  });

  it('rejects the same idempotency key with a changed command', async () => {
    const body = JSON.stringify(command);
    expect((await request('/v1/calls', { method: 'POST', body })).status).toBe(201);
    const changed = JSON.stringify({ ...command, callerId: '+61350324519' });
    const response = await request('/v1/calls', {
      method: 'POST',
      body: changed
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'GATEWAY_COMMAND_CONFLICT'
    });
  });

  it('permits only one active request for a provider user', async () => {
    const second = {
      ...command,
      gatewayCallId: '44444444-4444-4444-8444-444444444444',
      voiceCallId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'voice-call-2'
    };
    const responses = await Promise.all([
      request('/v1/calls', { method: 'POST', body: JSON.stringify(command) }),
      request('/v1/calls', { method: 'POST', body: JSON.stringify(second) })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it('rejects a replayed nonce and a tampered signature', async () => {
    const body = JSON.stringify(command);
    const nonce = 'nonce-replay-00000001';
    expect(
      (await request('/v1/calls', { method: 'POST', body, nonce })).status
    ).toBe(201);
    expect(
      (await request('/v1/calls', { method: 'POST', body, nonce })).status
    ).toBe(409);
    expect(
      (
        await request('/v1/calls', {
          method: 'POST',
          body,
          secretOverride: 'wrong-secret'
        })
      ).status
    ).toBe(401);
  });

  it('rejects unsupported flows and arbitrary script or audio fields', async () => {
    const unsupported = await request('/v1/calls', {
      method: 'POST',
      body: JSON.stringify({ ...command, flowVersion: 2 })
    });
    expect(unsupported.status).toBe(400);

    const scripted = await request('/v1/calls', {
      method: 'POST',
      body: JSON.stringify({ ...command, script: 'Say anything supplied here' })
    });
    expect(scripted.status).toBe(400);

    const audio = await request('/v1/calls', {
      method: 'POST',
      body: JSON.stringify({ ...command, audioUrl: 'https://example.invalid/a.wav' })
    });
    expect(audio.status).toBe(400);
  });
});
