import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { SinchClient } from './client.js';
import {
  SinchAuthenticationFailure,
  SinchPermanentSubmissionFailure,
  SinchTransientFailure,
  SinchValidationFailure
} from './types.js';

class FakeHttpClient implements HttpClient {
  requests: HttpRequest[] = [];
  responses: HttpResponse[] = [];

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fake response configured');
    return Promise.resolve(response);
  }
}

const clock = {
  now: () => new Date('2026-09-18T01:02:03.000Z')
};

const createClient = (http: HttpClient) =>
  new SinchClient({
    http,
    credentials: { apiKey: 'api-key', apiSecret: 'api-secret' },
    clock
  });

const submitInput = {
  content: 'Invoice reminder',
  destinationNumber: '+61400000001',
  callbackUrl: 'https://example.invalid/api/webhooks/sinch',
  metadata: { outbound_id: 'outbound-1' }
};

describe('SinchClient.sendSms', () => {
  it('submits one attributed message to the APAC endpoint', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 202,
      headers: {},
      body: JSON.stringify({
        messages: [{ message_id: 'message-1', status: 'QUEUED' }]
      })
    });

    await expect(createClient(http).sendSms(submitInput)).resolves.toEqual({
      kind: 'accepted',
      messageId: 'message-1',
      status: 'QUEUED'
    });

    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://au.app.api.sinch.com/v1/messages',
      headers: {
        Date: 'Fri, 18 Sep 2026 01:02:03 GMT',
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });
    expect(http.requests[0]?.headers.Authorization).toContain(
      'headers="Date Content-MD5 request-line"'
    );
    expect(JSON.parse(http.requests[0]?.body ?? '')).toEqual({
      messages: [
        {
          content: 'Invoice reminder',
          destination_number: '+61400000001',
          format: 'SMS',
          delivery_report: true,
          callback_url: 'https://example.invalid/api/webhooks/sinch',
          metadata: { outbound_id: 'outbound-1' }
        }
      ]
    });
  });

  it('rejects a non-E.164 destination before making a request', async () => {
    const http = new FakeHttpClient();
    await expect(
      createClient(http).sendSms({
        ...submitInput,
        destinationNumber: '0400 000 001'
      })
    ).rejects.toBeInstanceOf(SinchValidationFailure);
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    [400, SinchValidationFailure],
    [401, SinchAuthenticationFailure],
    [422, SinchPermanentSubmissionFailure],
    [503, SinchTransientFailure]
  ])('maps provider status %s', async (status, ErrorType) => {
    const http = new FakeHttpClient();
    http.responses.push({ status, headers: {}, body: 'provider error' });

    await expect(createClient(http).sendSms(submitInput)).rejects.toBeInstanceOf(
      ErrorType
    );
  });

  it('maps 429 with its retry delay', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 429,
      headers: { 'retry-after': '23' },
      body: ''
    });

    await expect(createClient(http).sendSms(submitInput)).rejects.toMatchObject({
      name: 'SinchRateLimited',
      retryAfterSeconds: 23
    });
  });
});

describe('SinchClient.getMessageStatus', () => {
  it('returns the provider status and status code', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({
        message_id: 'message-1',
        status: 'DELIVERED',
        status_code: 0
      })
    });

    await expect(
      createClient(http).getMessageStatus('message-1')
    ).resolves.toEqual({
      messageId: 'message-1',
      status: 'DELIVERED',
      statusCode: 0
    });
  });
});
