import type { HttpClient, HttpResponse } from '../http.js';
import {
  RetellAuthenticationError,
  type RetellCallStatus,
  type RetellCreatePhoneCallInput,
  RetellPermanentError,
  RetellRateLimitedError,
  type RetellSafeAnalysis,
  type RetellStructuredOutcome,
  RetellTransientError,
  RetellUnknownDispatchError
} from './types.js';

export interface RetellClientOptions {
  http: HttpClient;
  apiKey: string;
  baseUrl?: string;
}

const e164Pattern = /^\+[1-9]\d{7,14}$/;

const headerNumber = (
  headers: Record<string, string>,
  name: string
): number | null => {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  if (match === undefined) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const optionalProperty = <Key extends string, Value>(
  key: Key,
  value: Value | undefined
): Partial<Record<Key, Value>> =>
  value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);

export const parseRetellStructuredOutcome = (
  value: unknown
): RetellStructuredOutcome => {
  const data = asRecord(value);
  if (data === null) return {};
  return {
    ...optionalProperty('identityResult', nonEmptyString(data.identity_result)),
    ...optionalProperty('wrongPerson', booleanValue(data.wrong_person)),
    ...optionalProperty('voicemailLeft', booleanValue(data.voicemail_left)),
    ...optionalProperty(
      'transferRequested',
      booleanValue(data.transfer_requested)
    ),
    ...optionalProperty('transferResult', nonEmptyString(data.transfer_result)),
    ...optionalProperty('finalResult', nonEmptyString(data.final_result))
  };
};

const parseSafeAnalysis = (value: unknown): RetellSafeAnalysis | undefined => {
  const analysis = asRecord(value);
  if (analysis === null) return undefined;
  return {
    ...optionalProperty('inVoicemail', booleanValue(analysis.in_voicemail)),
    ...optionalProperty(
      'callSuccessful',
      booleanValue(analysis.call_successful)
    ),
    structuredOutcome: parseRetellStructuredOutcome(
      analysis.custom_analysis_data
    )
  };
};

export const parseRetellCallStatus = (value: unknown): RetellCallStatus => {
  const payload = asRecord(value);
  const callId = nonEmptyString(payload?.call_id);
  const callStatus = nonEmptyString(payload?.call_status);
  if (callId === undefined || callStatus === undefined) {
    throw new Error('Retell returned a malformed call status');
  }
  return {
    callId,
    callStatus,
    ...optionalProperty('startTimestamp', finiteNumber(payload?.start_timestamp)),
    ...optionalProperty('endTimestamp', finiteNumber(payload?.end_timestamp)),
    ...optionalProperty(
      'disconnectionReason',
      nonEmptyString(payload?.disconnection_reason)
    ),
    ...optionalProperty('analysis', parseSafeAnalysis(payload?.call_analysis))
  };
};

export class RetellClient {
  private readonly baseUrl: string;

  constructor(private readonly options: RetellClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.retellai.com').replace(
      /\/$/,
      ''
    );
  }

  async createPhoneCall(
    input: RetellCreatePhoneCallInput
  ): Promise<{ callId: string; callStatus: string }> {
    if (!e164Pattern.test(input.fromNumber) || !e164Pattern.test(input.toNumber)) {
      throw new RetellPermanentError(
        null,
        'Retell phone numbers must use E.164 format'
      );
    }
    if (
      input.idempotencyKey.trim() === '' ||
      input.agentId.trim() === '' ||
      !Number.isInteger(input.agentVersion) ||
      input.agentVersion < 0
    ) {
      throw new RetellPermanentError(
        null,
        'Retell call identifiers and pinned agent version are required'
      );
    }

    const path = '/v2/create-phone-call';
    let response: HttpResponse;
    try {
      response = await this.request(
        'POST',
        path,
        JSON.stringify({
          from_number: input.fromNumber,
          to_number: input.toNumber,
          idempotency_key: input.idempotencyKey,
          honor_internal_dnc: true,
          override_agent_id: input.agentId,
          override_agent_version: input.agentVersion,
          retell_llm_dynamic_variables: input.dynamicVariables,
          metadata: input.metadata
        })
      );
    } catch (error) {
      if (error instanceof RetellPermanentError) throw error;
      throw new RetellUnknownDispatchError();
    }

    if (![200, 201].includes(response.status)) {
      this.throwForResponse(response);
    }
    try {
      const status = parseRetellCallStatus(JSON.parse(response.body));
      return { callId: status.callId, callStatus: status.callStatus };
    } catch {
      throw new RetellUnknownDispatchError(
        'Retell accepted the call but returned no usable call identifier'
      );
    }
  }

  async getCall(callId: string): Promise<RetellCallStatus> {
    if (callId.trim() === '') {
      throw new RetellPermanentError(null, 'Retell call identifier is required');
    }
    let response: HttpResponse;
    try {
      response = await this.request(
        'GET',
        `/v2/get-call/${encodeURIComponent(callId)}`
      );
    } catch {
      throw new RetellTransientError(null, 'Retell status lookup failed');
    }
    if (response.status !== 200) this.throwForResponse(response);
    try {
      return parseRetellCallStatus(JSON.parse(response.body));
    } catch {
      throw new RetellTransientError(
        response.status,
        'Retell returned malformed call status'
      );
    }
  }

  private request(
    method: 'GET' | 'POST',
    path: string,
    body?: string
  ): Promise<HttpResponse> {
    return this.options.http.request({
      method,
      url: `${this.baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body })
    });
  }

  private throwForResponse(response: HttpResponse): never {
    const message = `Retell returned status ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new RetellAuthenticationError(response.status, message);
    }
    if (response.status === 429) {
      throw new RetellRateLimitedError(
        headerNumber(response.headers, 'retry-after'),
        message
      );
    }
    if (response.status >= 500) {
      throw new RetellTransientError(response.status, message);
    }
    throw new RetellPermanentError(response.status, message);
  }
}
