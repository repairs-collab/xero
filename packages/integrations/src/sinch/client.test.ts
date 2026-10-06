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

describe('SinchClient.checkConnection', () => {
  it('authenticates with the read-only APAC replies endpoint', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({ page: 0, pageSize: 1, pageData: [] })
    });

    await expect(createClient(http).checkConnection()).resolves.toEqual({
      kind: 'healthy'
    });
    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://au.app.api.sinch.com/v1/replies',
      headers: {
        Date: 'Fri, 18 Sep 2026 01:02:03 GMT',
        Accept: 'application/json'
      }
    });
    expect(http.requests[0]?.headers.Authorization).toContain(
      'headers="Date request-line"'
    );
    expect(http.requests[0]?.headers).not.toHaveProperty('Content-MD5');
    expect(http.requests[0]?.headers).not.toHaveProperty('Content-Type');
    expect(http.requests[0]).not.toHaveProperty('body');
  });
});

describe('SinchClient reply recovery', () => {
  it('maps unconfirmed APAC replies and confirms only processed ids', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          replies: [
            {
              message_id: 'message-1',
              reply_id: 'reply-1',
              date_received: '2026-10-05T01:02:03Z',
              destination_number: '+61400000002',
              source_number: '+61400000001',
              content: 'Paid today',
              metadata: { invoice: 'INV-1', ignored: 42 }
            },
            {
              reply_id: 'reply-2',
              date_received: '2026-10-05T02:02:03Z',
              source_number: '+61400000003',
              content: 'Call me',
              metadata: {}
            }
          ]
        })
      },
      { status: 202, headers: {}, body: '' }
    );
    const client = createClient(http);

    await expect(client.checkReplies()).resolves.toEqual([
      {
        kind: 'reply',
        replyId: 'reply-1',
        messageId: 'message-1',
        from: '+61400000001',
        to: '+61400000002',
        receivedAt: '2026-10-05T01:02:03Z',
        content: 'Paid today',
        metadata: { invoice: 'INV-1' }
      },
      {
        kind: 'reply',
        replyId: 'reply-2',
        from: '+61400000003',
        receivedAt: '2026-10-05T02:02:03Z',
        content: 'Call me',
        metadata: {}
      }
    ]);
    await expect(client.confirmReplies(['reply-1'])).resolves.toBeUndefined();

    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://au.app.api.sinch.com/v1/replies'
    });
    expect(http.requests[1]).toMatchObject({
      method: 'POST',
      url: 'https://au.app.api.sinch.com/v1/replies/confirmed'
    });
    expect(JSON.parse(http.requests[1]?.body ?? '')).toEqual({
      reply_ids: ['reply-1']
    });
  });

  it('rejects a malformed reply list without confirming anything', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({ replies: [{ reply_id: 'reply-1' }] })
    });

    await expect(createClient(http).checkReplies()).rejects.toBeInstanceOf(
      SinchTransientFailure
    );
    expect(http.requests).toHaveLength(1);
  });
});
