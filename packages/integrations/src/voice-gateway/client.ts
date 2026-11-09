import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { HttpClient, HttpResponse } from '../http.js';
import {
  VoiceGatewayAuthenticationError,
  VoiceGatewayConflictError,
  VoiceGatewayPermanentError,
  VoiceGatewayTransientError,
  VoiceGatewayUnknownDispatchError,
  type VoiceGatewayCallCommand,
  type VoiceGatewayCallStatus,
  type VoiceGatewayCreateResult,
  type VoiceGatewayHealth,
  type VoiceGatewaySessionState
} from './types.js';

export interface VoiceGatewayClientOptions {
  http: HttpClient;
  signingSecret: string;
  baseUrl?: string;
  clock?: { now(): Date };
  nonce?: () => string;
}

const gatewayStates = new Set<VoiceGatewaySessionState>([
  'PENDING',
  'PROVIDER_REQUESTED',
  'GATEWAY_LEG_ANSWERED',
  'CUSTOMER_RINGING',
  'CUSTOMER_ANSWERED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED'
]);

const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseBody = (response: HttpResponse): Record<string, unknown> | null => {
  try {
    return recordValue(JSON.parse(response.body) as unknown);
  } catch {
    return null;
  }
};

const signature = (input: {
  secret: string;
  method: 'GET' | 'POST';
  path: string;
  body: string;
  timestamp: string;
  nonce: string;
}): string => {
  const canonical = [
    'v1',
    input.timestamp,
    input.nonce,
    input.method,
    input.path,
    createHash('sha256').update(input.body, 'utf8').digest('hex')
  ].join('\n');
  return `v1=${createHmac('sha256', input.secret).update(canonical).digest('hex')}`;
};

const isState = (value: unknown): value is VoiceGatewaySessionState =>
  typeof value === 'string' && gatewayStates.has(value as VoiceGatewaySessionState);

const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export class VoiceGatewayClient {
  private readonly baseUrl: string;
  private readonly clock: { now(): Date };
  private readonly nonce: () => string;

  constructor(private readonly options: VoiceGatewayClientOptions) {
    if (options.signingSecret.trim() === '') {
      throw new VoiceGatewayPermanentError(null);
    }
    this.baseUrl = (options.baseUrl ?? 'http://voice-gateway:3105').replace(
      /\/$/,
      ''
    );
    this.clock = options.clock ?? { now: () => new Date() };
    this.nonce = options.nonce ?? randomUUID;
  }

  async health(): Promise<VoiceGatewayHealth> {
    const response = await this.request('GET', '/health/ready', '', false);
    const body = parseBody(response);
    if (
      body?.ready !== true ||
      !Number.isSafeInteger(body.version) ||
      body.provider !== 'VOIPCLOUD' ||
      typeof body.callsEnabled !== 'boolean'
    ) {
      throw new VoiceGatewayTransientError(response.status);
    }
    return {
      ready: true,
      version: body.version as number,
      provider: 'VOIPCLOUD',
      callsEnabled: body.callsEnabled
    };
  }

  async createCall(
    command: VoiceGatewayCallCommand
  ): Promise<VoiceGatewayCreateResult> {
    const bodyText = JSON.stringify(command);
    const response = await this.request('POST', '/v1/calls', bodyText, true);
    const body = parseBody(response);
    if (
      body === null ||
      body.gatewayCallId !== command.gatewayCallId ||
      !isState(body.state) ||
      typeof body.created !== 'boolean'
    ) {
      throw new VoiceGatewayUnknownDispatchError();
    }
    return {
      gatewayCallId: body.gatewayCallId,
      state: body.state,
      created: body.created
    };
  }

  async getCall(gatewayCallId: string): Promise<VoiceGatewayCallStatus> {
    const response = await this.request(
      'GET',
      `/v1/calls/${encodeURIComponent(gatewayCallId)}`,
      '',
      false
    );
    const body = parseBody(response);
    if (
      body === null ||
      body.gatewayCallId !== gatewayCallId ||
      typeof body.organisationId !== 'string' ||
      typeof body.voiceCallId !== 'string' ||
      typeof body.providerUserNumber !== 'string' ||
      !isState(body.state) ||
      !isSafeInteger(body.lastEventSequence) ||
      (body.safeFailureCode !== null &&
        typeof body.safeFailureCode !== 'string') ||
      typeof body.createdAt !== 'string' ||
      typeof body.updatedAt !== 'string'
    ) {
      throw new VoiceGatewayTransientError(response.status);
    }
    return {
      gatewayCallId: body.gatewayCallId,
      organisationId: body.organisationId,
      voiceCallId: body.voiceCallId,
      providerUserNumber: body.providerUserNumber,
      state: body.state,
      lastEventSequence: body.lastEventSequence,
      safeFailureCode: body.safeFailureCode,
      createdAt: body.createdAt,
      updatedAt: body.updatedAt
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: string,
    dispatch: boolean
  ): Promise<HttpResponse> {
    const timestamp = String(this.clock.now().getTime());
    const nonce = this.nonce();
    let response: HttpResponse;
    try {
      response = await this.options.http.request({
        method,
        url: `${this.baseUrl}${path}`,
        headers: {
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          'x-accountpulse-timestamp': timestamp,
          'x-accountpulse-nonce': nonce,
          'x-accountpulse-signature': signature({
            secret: this.options.signingSecret,
            method,
            path,
            body,
            timestamp,
            nonce
          })
        },
        ...(method === 'POST' ? { body } : {})
      });
    } catch {
      if (dispatch) throw new VoiceGatewayUnknownDispatchError();
      throw new VoiceGatewayTransientError(null);
    }
    if (response.status === 401 || response.status === 403) {
      throw new VoiceGatewayAuthenticationError();
    }
    if (response.status === 409) {
      const code = parseBody(response)?.error;
      throw new VoiceGatewayConflictError(
        typeof code === 'string' ? code : 'GATEWAY_CONFLICT'
      );
    }
    if (response.status >= 500) {
      if (dispatch) throw new VoiceGatewayUnknownDispatchError();
      throw new VoiceGatewayTransientError(response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new VoiceGatewayPermanentError(response.status);
    }
    return response;
  }
}
