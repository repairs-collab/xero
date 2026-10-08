import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { VoipcloudClient } from './client.js';
import {
  VoipcloudAuthenticationError,
  VoipcloudLicenceError,
  VoipcloudPermanentError,
  VoipcloudRateLimitedError,
  VoipcloudTransientError,
  VoipcloudUnknownDispatchError
} from './types.js';

class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  readonly responses: Array<HttpResponse | Error> = [];

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fake response configured');
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  }
}

const apiKey = 'voipcloud-secret-key';
const createClient = (http: HttpClient) =>
  new VoipcloudClient({ http, apiKey });

const callInput = {
  userNumber: '1010',
  numberToCall: '+61400000001',
  callerId: '+61350324518'
};

const acceptedBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    code: 200,
    data: {
      user_name: 'AccountPulse Gateway',
      user_number: '1010',
      caller_id: '+61350324518',
      dest_number: '+61400000001',
      ...overrides
    },
    message: { status: 'success' }
  });

describe('VoipcloudClient.callToNumber', () => {
  it('posts the documented multipart request to the fixed Australian endpoint', async () => {
    const http = new FakeHttpClient();
    http.responses.push({ status: 200, headers: {}, body: acceptedBody() });

    await expect(createClient(http).callToNumber(callInput)).resolves.toEqual({
      status: 'accepted',
      userNumber: '1010',
      destinationNumber: '+61400000001',
      callerId: '+61350324518'
    });

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://au.voipcloud.online/api/integration/v2/call-to-number',
      headers: {
        token: apiKey,
        Accept: 'application/json'
      }
    });
    expect(http.requests[0]?.headers['Content-Type']).toMatch(
      /^multipart\/form-data; boundary=/
    );
    expect(http.requests[0]?.body).toContain('name="user_number"\r\n\r\n1010');
    expect(http.requests[0]?.body).toContain(
      'name="number_to_call"\r\n\r\n+61400000001'
    );
    expect(http.requests[0]?.body).toContain(
      'name="caller_id"\r\n\r\n+61350324518'
    );
  });

  it('preserves a provider call id only when VoIPcloud supplies one', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: acceptedBody({ unique_call_id: 'provider-call-1' })
    });

    await expect(createClient(http).callToNumber(callInput)).resolves.toEqual(
      expect.objectContaining({ providerCallId: 'provider-call-1' })
    );
  });

  it.each([
    [{ ...callInput, userNumber: '' }, 'user number'],
    [{ ...callInput, numberToCall: '0400 000 001' }, 'E.164'],
    [{ ...callInput, callerId: '03 5032 4518' }, 'E.164']
  ])('rejects invalid input before dispatch: %s', async (input, message) => {
    const http = new FakeHttpClient();
    await expect(createClient(http).callToNumber(input)).rejects.toMatchObject({
      name: 'VoipcloudPermanentError',
      message: expect.stringContaining(message)
    });
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    [400, '{}', VoipcloudPermanentError],
    [401, '{}', VoipcloudAuthenticationError],
    [403, '{}', VoipcloudAuthenticationError],
    [402, '{"error":"licence_required"}', VoipcloudLicenceError],
    [400, '{"error":"user has no call licence"}', VoipcloudLicenceError],
    [503, '{}', VoipcloudTransientError]
  ])('maps provider status %s safely', async (status, body, ErrorType) => {
    const http = new FakeHttpClient();
    http.responses.push({ status, headers: {}, body });

    await expect(createClient(http).callToNumber(callInput)).rejects.toBeInstanceOf(
      ErrorType
    );
  });

  it('maps rate limiting with Retry-After', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 429,
      headers: { 'retry-after': '17' },
      body: '{}'
    });

    await expect(createClient(http).callToNumber(callInput)).rejects.toMatchObject({
      name: 'VoipcloudRateLimitedError',
      retryAfterSeconds: 17
    });
  });

  it('treats a failed POST or malformed success as unknown dispatch', async () => {
    const failedHttp = new FakeHttpClient();
    failedHttp.responses.push(new Error(`connection reset ${apiKey}`));
    await expect(
      createClient(failedHttp).callToNumber(callInput)
    ).rejects.toBeInstanceOf(VoipcloudUnknownDispatchError);

    const malformedHttp = new FakeHttpClient();
    malformedHttp.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 200, message: { status: 'success' } })
    });
    await expect(
      createClient(malformedHttp).callToNumber(callInput)
    ).rejects.toBeInstanceOf(VoipcloudUnknownDispatchError);
  });

  it('never includes the API key or provider body in an error message', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 400,
      headers: {},
      body: `rejected ${apiKey}`
    });

    const error = await createClient(http)
      .callToNumber(callInput)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain('rejected');
  });
});

describe('VoipcloudClient.getUserCalls', () => {
  it('queries documented call history and returns only the requested user', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({
        code: 200,
        data: [
          {
            unique_call_id: 'call-1',
            type: 'user_outbound_answered',
            caller_id: '+61350324518',
            caller_name: 'Mott Appliance Repairs',
            dest_number: '+61400000001',
            user_name: 'AccountPulse Gateway',
            user_number: '1010',
            call_start_at: '2026-10-09T00:00:00.000Z',
            connected_at: '2026-10-09T00:00:04.000Z',
            call_duration: 28,
            conversation_duration: 14,
            recording_url: 'must-not-be-returned'
          },
          {
            unique_call_id: 'other-user',
            type: 'user_outbound_answered',
            dest_number: '+61400000002',
            user_name: 'Other user',
            user_number: '2020',
            call_start_at: '2026-10-09T00:01:00.000Z',
            call_duration: 5
          }
        ]
      })
    });

    const result = await createClient(http).getUserCalls({
      userNumber: '1010',
      from: new Date('2026-10-08T23:00:00.000Z'),
      to: new Date('2026-10-09T02:00:00.000Z')
    });

    expect(result).toEqual([
      {
        uniqueCallId: 'call-1',
        type: 'user_outbound_answered',
        callerId: '+61350324518',
        callerName: 'Mott Appliance Repairs',
        destinationNumber: '+61400000001',
        userName: 'AccountPulse Gateway',
        userNumber: '1010',
        callStartedAt: '2026-10-09T00:00:00.000Z',
        connectedAt: '2026-10-09T00:00:04.000Z',
        callDurationSeconds: 28,
        conversationDurationSeconds: 14
      }
    ]);
    const requestUrl = new URL(http.requests[0]?.url ?? '');
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
      'https://au.voipcloud.online/api/integration/v2/get-user-calls'
    );
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      sort_by: 'newest_first',
      from_date: '2026-10-08',
      to_date: '2026-10-09',
      offset: '0',
      limit: '10000'
    });
    expect(http.requests[0]?.headers.token).toBe(apiKey);
    expect(JSON.stringify(result)).not.toMatch(/recording/i);
  });

  it('maps transport and malformed history responses to transient failures', async () => {
    const transportHttp = new FakeHttpClient();
    transportHttp.responses.push(new Error(`network failure ${apiKey}`));
    await expect(
      createClient(transportHttp).getUserCalls({
        userNumber: '1010',
        from: new Date('2026-10-08T00:00:00.000Z'),
        to: new Date('2026-10-09T00:00:00.000Z')
      })
    ).rejects.toBeInstanceOf(VoipcloudTransientError);

    const malformedHttp = new FakeHttpClient();
    malformedHttp.responses.push({ status: 200, headers: {}, body: '{bad-json' });
    await expect(
      createClient(malformedHttp).getUserCalls({
        userNumber: '1010',
        from: new Date('2026-10-08T00:00:00.000Z'),
        to: new Date('2026-10-09T00:00:00.000Z')
      })
    ).rejects.toBeInstanceOf(VoipcloudTransientError);
  });
});
