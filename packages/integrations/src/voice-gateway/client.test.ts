import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { HttpRequest } from '../http.js';
import {
  VoiceGatewayClient,
  VoiceGatewayUnknownDispatchError
} from './index.js';

const response = (status: number, body: unknown) => ({
  status,
  headers: {},
  body: JSON.stringify(body)
});

const expectedSignature = (request: HttpRequest): string => {
  const timestamp = request.headers['x-accountpulse-timestamp'] ?? '';
  const nonce = request.headers['x-accountpulse-nonce'] ?? '';
  const path = new URL(request.url).pathname;
  const body = request.body ?? '';
  const canonical = [
    'v1',
    timestamp,
    nonce,
    request.method,
    path,
    createHash('sha256').update(body, 'utf8').digest('hex')
  ].join('\n');
  return `v1=${createHmac('sha256', 'shared-secret').update(canonical).digest('hex')}`;
};

const command = {
  version: 1 as const,
  purpose: 'TEST' as const,
  gatewayCallId: '11111111-1111-4111-8111-111111111111',
  organisationId: '22222222-2222-4222-8222-222222222222',
  voiceCallId: '33333333-3333-4333-8333-333333333333',
  idempotencyKey: 'voice-test:33333333-3333-4333-8333-333333333333',
  provider: 'VOIPCLOUD' as const,
  providerUserNumber: '1099',
  destinationNumber: '+61476057649',
  callerId: '+61350324518',
  flowVersion: 1,
  ttsVoiceId: 'en_GB-alba-medium',
  callbackUrl: 'http://web:3000/api/webhooks/voice-gateway',
  transfer: {
    sipUri: 'sip:1003@asterisk',
    fallbackNumber: '+61350324518',
    label: 'Main office queue — Tab 1'
  },
  approvedFacts: {
    accountName: 'Example Account',
    combinedAmount: '123.45',
    currency: 'AUD',
    invoices: [
      { invoiceNumber: 'INV-100', amountDue: '123.45', dueDate: '2026-09-01' }
    ]
  }
};

describe('VoiceGatewayClient', () => {
  it('sends a signed, idempotent VoIPcloud gateway command', async () => {
    let request: HttpRequest | undefined;
    const http = {
      request: vi.fn((input: HttpRequest) => {
        request = input;
        return Promise.resolve(
          response(201, {
            gatewayCallId: command.gatewayCallId,
            state: 'PENDING',
            created: true
          })
        );
      })
    };
    const client = new VoiceGatewayClient({
      http,
      baseUrl: 'http://voice-gateway:3105',
      signingSecret: 'shared-secret',
      clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
      nonce: () => 'nonce-1234567890abcdef'
    });

    await expect(client.createCall(command)).resolves.toEqual({
      gatewayCallId: command.gatewayCallId,
      state: 'PENDING',
      created: true
    });
    expect(request).toBeDefined();
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://voice-gateway:3105/v1/calls',
      headers: {
        'content-type': 'application/json',
        'x-accountpulse-timestamp': '1791763200000',
        'x-accountpulse-nonce': 'nonce-1234567890abcdef'
      },
      body: JSON.stringify(command)
    });
    expect(request?.headers['x-accountpulse-signature']).toBe(
      expectedSignature(request as HttpRequest)
    );
  });

  it('returns safe readiness and call status values', async () => {
    const http = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          response(200, {
            ready: true,
            version: 1,
            provider: 'VOIPCLOUD',
            callsEnabled: false
          })
        )
        .mockResolvedValueOnce(
          response(200, {
            gatewayCallId: command.gatewayCallId,
            organisationId: command.organisationId,
            voiceCallId: command.voiceCallId,
            providerUserNumber: '1099',
            state: 'COMPLETED',
            lastEventSequence: 8,
            safeFailureCode: null,
            createdAt: '2026-10-12T00:00:00.000Z',
            updatedAt: '2026-10-12T00:02:00.000Z'
          })
        )
    };
    const client = new VoiceGatewayClient({
      http,
      baseUrl: 'http://voice-gateway:3105',
      signingSecret: 'shared-secret',
      clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
      nonce: () => 'nonce-1234567890abcdef'
    });

    await expect(client.health()).resolves.toEqual({
      ready: true,
      version: 1,
      provider: 'VOIPCLOUD',
      callsEnabled: false
    });
    await expect(client.getCall(command.gatewayCallId)).resolves.toMatchObject({
      gatewayCallId: command.gatewayCallId,
      state: 'COMPLETED',
      lastEventSequence: 8
    });
  });

  it('treats transport loss during submission as an unknown dispatch and never leaks the secret', async () => {
    const client = new VoiceGatewayClient({
      http: { request: () => Promise.reject(new Error('shared-secret')) },
      baseUrl: 'http://voice-gateway:3105',
      signingSecret: 'shared-secret'
    });

    let error: unknown;
    try {
      await client.createCall(command);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VoiceGatewayUnknownDispatchError);
    expect(String(error)).not.toContain('shared-secret');
  });
});
