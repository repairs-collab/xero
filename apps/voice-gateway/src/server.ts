import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  hashGatewayCommand,
  parseCreateGatewayCallCommand
} from './contracts.js';
import type { GatewaySessionRecord, GatewaySessionStore } from './session-store.js';
import {
  InMemoryReplayProtector,
  verifyGatewayRequest,
  type GatewayHttpMethod
} from './signatures.js';

const maximumBodyBytes = 64 * 1024;

export interface GatewayServerDependencies {
  store: GatewaySessionStore;
  signingSecret: string;
  clock: { now(): Date };
  supportedFlowVersion: number;
  replayProtector?: InMemoryReplayProtector;
}

const sendJson = (
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
};

const firstHeader = (
  request: IncomingMessage,
  name: string
): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    length += chunk.byteLength;
    if (length > maximumBodyBytes) throw new Error('GATEWAY_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const safeSession = (session: GatewaySessionRecord): Record<string, unknown> => ({
  gatewayCallId: session.gatewayCallId,
  organisationId: session.organisationId,
  voiceCallId: session.voiceCallId,
  providerUserNumber: session.providerUserNumber,
  state: session.state,
  lastEventSequence: session.lastEventSequence,
  safeFailureCode: session.safeFailureCode,
  createdAt: session.createdAt.toISOString(),
  updatedAt: session.updatedAt.toISOString()
});

export const createGatewayServer = (dependencies: GatewayServerDependencies) => {
  const replayProtector =
    dependencies.replayProtector ?? new InMemoryReplayProtector();

  return createServer((request, response) => {
    void (async () => {
      const method = request.method;
      if (method !== 'GET' && method !== 'POST') {
        sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://voice-gateway.internal');
      let body: string;
      try {
        body = await readBody(request);
      } catch {
        sendJson(response, 413, { error: 'REQUEST_TOO_LARGE' });
        return;
      }

      const timestamp = firstHeader(request, 'x-accountpulse-timestamp');
      const nonce = firstHeader(request, 'x-accountpulse-nonce');
      const signature = firstHeader(request, 'x-accountpulse-signature');
      const now = dependencies.clock.now();
      if (
        timestamp === undefined ||
        nonce === undefined ||
        signature === undefined ||
        !verifyGatewayRequest({
          secret: dependencies.signingSecret,
          method: method as GatewayHttpMethod,
          path: url.pathname,
          body,
          timestamp,
          nonce,
          signature,
          now
        })
      ) {
        sendJson(response, 401, { error: 'GATEWAY_AUTHENTICATION_FAILED' });
        return;
      }
      if (!replayProtector.claim(nonce, now)) {
        sendJson(response, 409, { error: 'GATEWAY_REPLAY_DETECTED' });
        return;
      }

      if (method === 'GET' && url.pathname === '/health/ready') {
        sendJson(response, 200, {
          ready: true,
          version: dependencies.supportedFlowVersion
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/calls') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          sendJson(response, 400, { error: 'GATEWAY_COMMAND_INVALID' });
          return;
        }
        let command;
        try {
          command = parseCreateGatewayCallCommand(
            parsed,
            dependencies.supportedFlowVersion
          );
        } catch {
          sendJson(response, 400, { error: 'GATEWAY_COMMAND_INVALID' });
          return;
        }
        const result = await dependencies.store.createOrGet({
          gatewayCallId: command.gatewayCallId,
          organisationId: command.organisationId,
          voiceCallId: command.voiceCallId,
          providerUserNumber: command.providerUserNumber,
          idempotencyKey: command.idempotencyKey,
          commandHash: hashGatewayCommand(command),
          now
        });
        if (result.kind === 'conflict') {
          sendJson(response, 409, { error: result.code });
          return;
        }
        sendJson(response, result.kind === 'created' ? 201 : 200, {
          gatewayCallId: result.session.gatewayCallId,
          state: result.session.state,
          created: result.kind === 'created'
        });
        return;
      }

      const statusMatch = /^\/v1\/calls\/([0-9a-f-]{36})$/i.exec(url.pathname);
      if (method === 'GET' && statusMatch?.[1] !== undefined) {
        const session = await dependencies.store.findByGatewayCallId(
          statusMatch[1]
        );
        if (session === null) {
          sendJson(response, 404, { error: 'GATEWAY_CALL_NOT_FOUND' });
          return;
        }
        sendJson(response, 200, safeSession(session));
        return;
      }

      sendJson(response, 404, { error: 'NOT_FOUND' });
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'GATEWAY_INTERNAL_ERROR' });
      } else {
        response.destroy();
      }
    });
  });
};
