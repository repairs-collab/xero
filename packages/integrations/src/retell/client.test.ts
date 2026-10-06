import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { RetellClient } from './client.js';
import {
  RetellAuthenticationError,
  RetellPermanentError,
  RetellTransientError,
  RetellUnknownDispatchError
} from './types.js';

class FakeHttpClient implements HttpClient {
  requests: HttpRequest[] = [];
  responses: Array<HttpResponse | Error> = [];

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fake response configured');
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  }
}

const createClient = (http: HttpClient) =>
  new RetellClient({ http, apiKey: 'retell-secret' });

const createInput = {
  fromNumber: '+61255501234',
  toNumber: '+61400000001',
  idempotencyKey: 'accountpulse:org-1:voice-1',
  agentId: 'agent_accountpulse',
  agentVersion: 7,
  dynamicVariables: {
    approved_script: 'Approved reminder script',
    accountpulse_call_id: 'voice-1'
  },
  metadata: {
    organisation_id: 'org-1',
    voice_call_id: 'voice-1'
  }
};

describe('RetellClient.createPhoneCall', () => {
  it('submits the approved call contract without retention overrides', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 201,
      headers: {},
      body: JSON.stringify({
        call_id: 'call_retell_1',
        call_status: 'registered',
        transcript: 'must not be read',
        recording_url: 'https://example.invalid/private.wav'
      })
    });

    await expect(
      createClient(http).createPhoneCall(createInput)
    ).resolves.toEqual({
      callId: 'call_retell_1',
      callStatus: 'registered'
    });

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.retellai.com/v2/create-phone-call',
      headers: {
        Authorization: 'Bearer retell-secret',
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    const body = JSON.parse(http.requests[0]?.body ?? '') as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      from_number: '+61255501234',
      to_number: '+61400000001',
      idempotency_key: 'accountpulse:org-1:voice-1',
      honor_internal_dnc: true,
      override_agent_id: 'agent_accountpulse',
      override_agent_version: 7,
      retell_llm_dynamic_variables: {
        approved_script: 'Approved reminder script',
        accountpulse_call_id: 'voice-1'
      },
      metadata: {
        organisation_id: 'org-1',
        voice_call_id: 'voice-1'
      }
    });
    expect(JSON.stringify(body)).not.toMatch(
      /record|transcript|data_storage|retention/i
    );
  });

  it('rejects invalid phone numbers before dispatch', async () => {
    const http = new FakeHttpClient();

    await expect(
      createClient(http).createPhoneCall({
        ...createInput,
        toNumber: '0400 000 001'
      })
    ).rejects.toBeInstanceOf(RetellPermanentError);
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    [400, RetellPermanentError],
    [401, RetellAuthenticationError],
    [403, RetellAuthenticationError],
    [422, RetellPermanentError],
    [503, RetellTransientError]
  ])('maps provider status %s', async (status, ErrorType) => {
    const http = new FakeHttpClient();
    http.responses.push({ status, headers: {}, body: 'provider error' });

    await expect(
      createClient(http).createPhoneCall(createInput)
    ).rejects.toBeInstanceOf(ErrorType);
  });

  it('maps rate limiting with Retry-After', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 429,
      headers: { 'retry-after': '19' },
      body: ''
    });

    await expect(
      createClient(http).createPhoneCall(createInput)
    ).rejects.toMatchObject({
      name: 'RetellRateLimitedError',
      retryAfterSeconds: 19
    });
  });

  it('treats transport failure and malformed acceptance as unknown dispatch', async () => {
    const failedHttp = new FakeHttpClient();
    failedHttp.responses.push(new Error('connection reset'));
    await expect(
      createClient(failedHttp).createPhoneCall(createInput)
    ).rejects.toBeInstanceOf(RetellUnknownDispatchError);

    const malformedHttp = new FakeHttpClient();
    malformedHttp.responses.push({
      status: 201,
      headers: {},
      body: JSON.stringify({ call_status: 'registered' })
    });
    await expect(
      createClient(malformedHttp).createPhoneCall(createInput)
    ).rejects.toBeInstanceOf(RetellUnknownDispatchError);
  });
});

describe('RetellClient.getCall', () => {
  it('uses the encoded known call id and returns only safe status fields', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({
        call_id: 'call/id',
        call_status: 'ended',
        start_timestamp: 1791331200000,
        end_timestamp: 1791331260000,
        disconnection_reason: 'user_hangup',
        transcript: 'private customer speech',
        recording_url: 'https://example.invalid/private.wav',
        call_analysis: {
          call_summary: 'private summary',
          in_voicemail: false,
          call_successful: true,
          custom_analysis_data: {
            identity_result: 'confirmed',
            wrong_person: false,
            transfer_result: 'bridged',
            final_result: 'transferred',
            unapproved_extra: 'discard me'
          }
        }
      })
    });

    const result = await createClient(http).getCall('call/id');

    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.retellai.com/v2/get-call/call%2Fid',
      headers: {
        Authorization: 'Bearer retell-secret',
        Accept: 'application/json'
      }
    });
    expect(result).toEqual({
      callId: 'call/id',
      callStatus: 'ended',
      startTimestamp: 1791331200000,
      endTimestamp: 1791331260000,
      disconnectionReason: 'user_hangup',
      analysis: {
        inVoicemail: false,
        callSuccessful: true,
        structuredOutcome: {
          identityResult: 'confirmed',
          wrongPerson: false,
          transferResult: 'bridged',
          finalResult: 'transferred'
        }
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/transcript|recording|summary/i);
  });

  it('rejects an empty call id without issuing a request', async () => {
    const http = new FakeHttpClient();

    await expect(createClient(http).getCall('')).rejects.toBeInstanceOf(
      RetellPermanentError
    );
    expect(http.requests).toHaveLength(0);
  });
});
