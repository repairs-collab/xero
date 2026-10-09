import type { HttpClient, HttpResponse } from '../http.js';
import {
  VoipcloudAuthenticationError,
  VoipcloudLicenceError,
  VoipcloudPermanentError,
  VoipcloudRateLimitedError,
  VoipcloudTransientError,
  VoipcloudUnknownDispatchError,
  type VoipcloudCallLaunchInput,
  type VoipcloudCallLaunchResult,
  type VoipcloudGetUserCallsInput,
  type VoipcloudUserCall
} from './types.js';

export const VOIPCLOUD_AUSTRALIAN_API_BASE_URL =
  'https://au.voipcloud.online/api/integration/v2';

const e164Pattern = /^\+[1-9]\d{7,14}$/;
const userNumberPattern = /^\d{1,32}$/;
const multipartBoundary = '----AccountPulseVoipcloudBoundary7MA4YWxkTrZu0gW';

export interface VoipcloudClientOptions {
  http: HttpClient;
  apiKey: string;
  /** Tests may override the origin; production uses the fixed Australian URL. */
  baseUrl?: string;
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const optionalProperty = <K extends string, V>(
  key: K,
  value: V | undefined
): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });

const headerNumber = (
  headers: Readonly<Record<string, string>>,
  name: string
): number | null => {
  const target = name.toLowerCase();
  const value = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === target
  )?.[1];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const multipartBody = (
  fields: ReadonlyArray<readonly [name: string, value: string]>
): string =>
  fields
    .flatMap(([name, value]) => [
      `--${multipartBoundary}\r\n`,
      `Content-Disposition: form-data; name="${name}"\r\n\r\n`,
      `${value}\r\n`
    ])
    .concat(`--${multipartBoundary}--\r\n`)
    .join('');

const parseJsonRecord = (body: string): Record<string, unknown> | undefined => {
  try {
    return recordValue(JSON.parse(body) as unknown);
  } catch {
    return undefined;
  }
};

const parseUserCall = (value: unknown): VoipcloudUserCall | undefined => {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  const uniqueCallId = nonEmptyString(record.unique_call_id);
  const type = nonEmptyString(record.type);
  const destinationNumber = nonEmptyString(record.dest_number);
  const userName = nonEmptyString(record.user_name);
  const userNumber = nonEmptyString(record.user_number);
  const callStartedAt = nonEmptyString(record.call_start_at);
  if (
    uniqueCallId === undefined ||
    type === undefined ||
    destinationNumber === undefined ||
    userName === undefined ||
    userNumber === undefined ||
    callStartedAt === undefined
  ) {
    return undefined;
  }
  if (!Number.isFinite(new Date(callStartedAt).getTime())) return undefined;

  const connectedAt = nonEmptyString(record.connected_at);
  if (
    connectedAt !== undefined &&
    !Number.isFinite(new Date(connectedAt).getTime())
  ) {
    return undefined;
  }

  return {
    uniqueCallId,
    type,
    ...optionalProperty('callerId', nonEmptyString(record.caller_id)),
    ...optionalProperty('callerName', nonEmptyString(record.caller_name)),
    destinationNumber,
    userName,
    userNumber,
    callStartedAt,
    ...optionalProperty('connectedAt', connectedAt),
    ...optionalProperty(
      'callDurationSeconds',
      nonNegativeNumber(record.call_duration)
    ),
    ...optionalProperty(
      'conversationDurationSeconds',
      nonNegativeNumber(record.conversation_duration)
    )
  };
};

export class VoipcloudClient {
  private readonly baseUrl: string;

  constructor(private readonly options: VoipcloudClientOptions) {
    this.baseUrl = (
      options.baseUrl ?? VOIPCLOUD_AUSTRALIAN_API_BASE_URL
    ).replace(/\/$/, '');
    if (options.apiKey.trim() === '') {
      throw new VoipcloudPermanentError(null, 'VoIPcloud API key is required');
    }
  }

  async callToNumber(
    input: VoipcloudCallLaunchInput
  ): Promise<VoipcloudCallLaunchResult> {
    this.assertUserNumber(input.userNumber);
    if (!e164Pattern.test(input.numberToCall)) {
      throw new VoipcloudPermanentError(
        null,
        'VoIPcloud destination must use E.164 format'
      );
    }
    if (input.callerId !== undefined && !e164Pattern.test(input.callerId)) {
      throw new VoipcloudPermanentError(
        null,
        'VoIPcloud caller ID must use E.164 format'
      );
    }

    const fields: Array<readonly [string, string]> = [
      ['user_number', input.userNumber],
      ['number_to_call', input.numberToCall]
    ];
    if (input.callerId !== undefined) fields.push(['caller_id', input.callerId]);

    let response: HttpResponse;
    try {
      response = await this.options.http.request({
        method: 'POST',
        url: `${this.baseUrl}/call-to-number`,
        headers: {
          token: this.options.apiKey,
          Accept: 'application/json',
          'Content-Type': `multipart/form-data; boundary=${multipartBoundary}`
        },
        body: multipartBody(fields)
      });
    } catch (error) {
      if (error instanceof VoipcloudPermanentError) throw error;
      throw new VoipcloudUnknownDispatchError();
    }

    if (response.status < 200 || response.status >= 300) {
      this.throwForResponse(response);
    }
    if (response.status !== 200) throw new VoipcloudUnknownDispatchError();

    const payload = parseJsonRecord(response.body);
    const data = Array.isArray(payload?.data)
      ? recordValue(payload.data[0])
      : recordValue(payload?.data);
    const message = recordValue(payload?.message);
    const status = (
      nonEmptyString(payload?.status) ?? nonEmptyString(message?.status)
    )?.toLowerCase();
    if (
      payload === undefined ||
      (payload.code !== undefined && payload.code !== 200) ||
      (status !== undefined && status !== 'success')
    ) {
      throw new VoipcloudUnknownDispatchError(
        'VoIPcloud accepted the request but returned an unusable response'
      );
    }

    return {
      status: 'accepted',
      userNumber: input.userNumber,
      destinationNumber: input.numberToCall,
      ...optionalProperty('callerId', input.callerId),
      ...optionalProperty(
        'providerCallId',
        nonEmptyString(data?.unique_call_id)
      )
    };
  }

  async getUserCalls(
    input: VoipcloudGetUserCallsInput
  ): Promise<VoipcloudUserCall[]> {
    this.assertUserNumber(input.userNumber);
    if (
      !Number.isFinite(input.from.getTime()) ||
      !Number.isFinite(input.to.getTime()) ||
      input.from.getTime() > input.to.getTime()
    ) {
      throw new VoipcloudPermanentError(
        null,
        'VoIPcloud call-history range is invalid'
      );
    }

    const search = new URLSearchParams({
      sort_by: 'newest_first',
      from_date: input.from.toISOString().slice(0, 10),
      to_date: input.to.toISOString().slice(0, 10),
      offset: '0',
      limit: '10000'
    });
    let response: HttpResponse;
    try {
      response = await this.options.http.request({
        method: 'GET',
        url: `${this.baseUrl}/get-user-calls?${search.toString()}`,
        headers: { token: this.options.apiKey, Accept: 'application/json' }
      });
    } catch {
      throw new VoipcloudTransientError(
        null,
        'VoIPcloud call-history lookup failed'
      );
    }
    if (response.status !== 200) this.throwForResponse(response);

    const payload = parseJsonRecord(response.body);
    if (payload?.code !== 200 || !Array.isArray(payload.data)) {
      throw new VoipcloudTransientError(
        response.status,
        'VoIPcloud returned malformed call history'
      );
    }

    const result: VoipcloudUserCall[] = [];
    for (const rawCall of payload.data) {
      const record = recordValue(rawCall);
      if (nonEmptyString(record?.user_number) !== input.userNumber) continue;
      const call = parseUserCall(rawCall);
      if (call === undefined) {
        throw new VoipcloudTransientError(
          response.status,
          'VoIPcloud returned malformed call history'
        );
      }
      result.push(call);
    }
    return result;
  }

  private assertUserNumber(value: string): void {
    if (!userNumberPattern.test(value)) {
      throw new VoipcloudPermanentError(
        null,
        'VoIPcloud user number is required and must contain digits only'
      );
    }
  }

  private throwForResponse(response: HttpResponse): never {
    const genericMessage = `VoIPcloud returned status ${response.status}`;
    const bodyIndicatesLicence = /licen[cs]e|subscription/.test(
      response.body.toLowerCase()
    );
    if (response.status === 402 || bodyIndicatesLicence) {
      throw new VoipcloudLicenceError(response.status);
    }
    if (response.status === 401 || response.status === 403) {
      throw new VoipcloudAuthenticationError(response.status);
    }
    if (response.status === 429) {
      throw new VoipcloudRateLimitedError(
        headerNumber(response.headers, 'retry-after')
      );
    }
    if (response.status >= 500) {
      throw new VoipcloudTransientError(response.status, genericMessage);
    }
    throw new VoipcloudPermanentError(response.status, genericMessage);
  }
}
