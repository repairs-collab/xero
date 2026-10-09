import type { HttpClient, HttpResponse } from '../http.js';
import {
  RetellAuthenticationError,
  type RetellCallStatus,
  type RetellCreatePhoneCallInput,
  type RetellFinalResult,
  type RetellIdentityResult,
  RetellPermanentError,
  RetellRateLimitedError,
  type RetellSafeAnalysis,
  type RetellSafeMetadata,
  type RetellStructuredOutcome,
  type RetellTransferResult,
  RetellTransientError,
  RetellUnknownDispatchError
} from './types.js';

export interface RetellClientOptions {
  http: HttpClient;
  apiKey: string;
  baseUrl?: string;
}

const e164Pattern = /^\+[1-9]\d{7,14}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9_-]{5,255}$/;
const amountPattern = /^\d+(?:\.\d{1,4})?$/;
const approvedDynamicVariableNames = new Set([
  'accountpulse_call_id',
  'invoice_details_json',
  'combined_amount',
  'currency',
  'callback_number',
  'fallback_office_number',
  'transfer_sip_uri'
]);
const requiredDynamicVariableNames = [
  'accountpulse_call_id',
  'invoice_details_json',
  'combined_amount',
  'currency',
  'callback_number',
  'fallback_office_number'
] as const;
const approvedMetadataNames = new Set([
  'organisation_id',
  'voice_call_id'
]);
const identityResults = new Set<RetellIdentityResult>([
  'confirmed',
  'not_confirmed'
]);
const transferResults = new Set<RetellTransferResult>([
  'bridged',
  'unanswered',
  'failed'
]);
const finalResults = new Set<RetellFinalResult>([
  'details_delivered',
  'transferred',
  'transfer_unanswered',
  'voicemail_left',
  'wrong_person',
  'no_answer',
  'busy',
  'invalid_destination',
  'provider_rejected'
]);

const isApprovedInvoiceDetailsJson = (value: string): boolean => {
  try {
    const details: unknown = JSON.parse(value);
    return (
      Array.isArray(details) &&
      details.length > 0 &&
      details.every((detail) => {
        const item = asRecord(detail);
        if (item === null) return false;
        const names = Object.keys(item);
        return (
          names.length === 2 &&
          names.every((name) =>
            ['invoiceNumber', 'amountDue'].includes(name)
          ) &&
          nonEmptyString(item.invoiceNumber) !== undefined &&
          typeof item.amountDue === 'string' &&
          amountPattern.test(item.amountDue)
        );
      })
    );
  } catch {
    return false;
  }
};

const assertApprovedDynamicVariables = (
  variables: Readonly<Record<string, string>>
): void => {
  if (
    Object.keys(variables).some(
      (name) => !approvedDynamicVariableNames.has(name)
    ) ||
    requiredDynamicVariableNames.some(
      (name) => variables[name]?.trim() === '' || variables[name] === undefined
    ) ||
    !isApprovedInvoiceDetailsJson(variables.invoice_details_json ?? '') ||
    !amountPattern.test(variables.combined_amount ?? '') ||
    !/^[A-Z]{3}$/.test(variables.currency ?? '') ||
    !e164Pattern.test(variables.callback_number ?? '') ||
    !e164Pattern.test(variables.fallback_office_number ?? '') ||
    (variables.transfer_sip_uri !== undefined &&
      !/^sips?:[^\s]+$/i.test(variables.transfer_sip_uri))
  ) {
    throw new RetellPermanentError(
      null,
      'Retell dynamic variables contain unapproved or missing fields'
    );
  }
};

const assertApprovedMetadata = (
  metadata: Readonly<RetellSafeMetadata>
): void => {
  const values = metadata as Readonly<Record<string, string>>;
  if (
    Object.keys(values).some((name) => !approvedMetadataNames.has(name)) ||
    values.organisation_id?.trim() === '' ||
    values.voice_call_id?.trim() === ''
  ) {
    throw new RetellPermanentError(
      null,
      'Retell metadata contains unapproved or missing fields'
    );
  }
};

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

const approvedValue = <Value extends string>(
  value: unknown,
  approved: ReadonlySet<Value>
): Value | undefined =>
  typeof value === 'string' && approved.has(value as Value)
    ? (value as Value)
    : undefined;

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
    ...optionalProperty(
      'identityResult',
      approvedValue(data.identity_result, identityResults)
    ),
    ...optionalProperty('wrongPerson', booleanValue(data.wrong_person)),
    ...optionalProperty('voicemailLeft', booleanValue(data.voicemail_left)),
    ...optionalProperty(
      'transferRequested',
      booleanValue(data.transfer_requested)
    ),
    ...optionalProperty(
      'transferResult',
      approvedValue(data.transfer_result, transferResults)
    ),
    ...optionalProperty(
      'finalResult',
      approvedValue(data.final_result, finalResults)
    )
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
      !idempotencyKeyPattern.test(input.idempotencyKey) ||
      input.agentId.trim() === '' ||
      !Number.isInteger(input.agentVersion) ||
      input.agentVersion < 0
    ) {
      throw new RetellPermanentError(
        null,
        'Retell call identifiers and pinned agent version are required'
      );
    }
    assertApprovedDynamicVariables(input.dynamicVariables);
    assertApprovedMetadata(input.metadata);

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
