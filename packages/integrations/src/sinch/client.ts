import type { HttpClient, HttpResponse } from '../http.js';
import { signSinchRequest } from './hmac.js';
import {
  SinchAuthenticationFailure,
  SinchPermanentSubmissionFailure,
  SinchRateLimited,
  SinchTransientFailure,
  SinchUnknownSubmissionOutcome,
  SinchValidationFailure,
  type SinchClock,
  type SinchCredentials,
  type SinchMessageStatus,
  type SinchReplyEvent,
  type SinchSendSmsInput,
  type SinchSubmitResult
} from './types.js';
import { parseSinchReply } from './webhook.js';

export interface SinchClientOptions {
  http: HttpClient;
  credentials: SinchCredentials;
  clock: SinchClock;
  baseUrl?: string;
}

const e164Pattern = /^\+[1-9]\d{7,14}$/;
const accountIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

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

const errorMessage = (response: HttpResponse): string =>
  response.body === ''
    ? `Sinch returned status ${response.status}`
    : response.body;

export class SinchClient {
  private readonly baseUrl: string;

  constructor(private readonly options: SinchClientOptions) {
    this.baseUrl = (
      options.baseUrl ?? 'https://au.app.api.sinch.com'
    ).replace(/\/$/, '');
  }

  async sendSms(input: SinchSendSmsInput): Promise<SinchSubmitResult> {
    if (!e164Pattern.test(input.destinationNumber)) {
      throw new SinchValidationFailure(
        'Sinch destination number must be E.164'
      );
    }
    if (
      input.sourceNumber !== undefined &&
      !e164Pattern.test(input.sourceNumber)
    ) {
      throw new SinchValidationFailure('Sinch source number must be E.164');
    }
    if (input.accountId !== undefined && !accountIdPattern.test(input.accountId)) {
      throw new SinchValidationFailure('Sinch sub-account ID is invalid');
    }

    const path = '/v1/messages';
    const body = JSON.stringify({
      messages: [
        {
          content: input.content,
          destination_number: input.destinationNumber,
          ...(input.sourceNumber === undefined
            ? {}
            : { source_number: input.sourceNumber }),
          format: 'SMS',
          delivery_report: true,
          callback_url: input.callbackUrl,
          metadata: input.metadata
        }
      ]
    });
    const response = await this.request('POST', path, body, input.accountId);

    if (response.status === 202) {
      let message: { message_id?: unknown; status?: unknown } | undefined;
      try {
        const payload = JSON.parse(response.body) as {
          messages?: Array<{ message_id?: unknown; status?: unknown }>;
        } | null;
        message = payload?.messages?.[0];
      } catch {
        throw new SinchUnknownSubmissionOutcome(
          'Sinch accepted the request but returned an invalid response'
        );
      }
      if (
        typeof message?.message_id !== 'string' ||
        message.message_id.trim() === '' ||
        typeof message.status !== 'string'
      ) {
        throw new SinchUnknownSubmissionOutcome(
          'Sinch accepted the request but returned no message identifier'
        );
      }
      return {
        kind: 'accepted',
        messageId: message.message_id,
        status: message.status
      };
    }

    this.throwForResponse(response);
    throw new SinchTransientFailure(
      response.status,
      'Unexpected Sinch submission response'
    );
  }

  async getMessageStatus(messageId: string): Promise<SinchMessageStatus> {
    const path = `/v1/messages/${encodeURIComponent(messageId)}`;
    const response = await this.request('GET', path, '');
    if (response.status !== 200) this.throwForResponse(response);

    const payload = JSON.parse(response.body) as {
      message_id?: unknown;
      status?: unknown;
      status_code?: unknown;
    };
    if (
      typeof payload.message_id !== 'string' ||
      typeof payload.status !== 'string'
    ) {
      throw new SinchTransientFailure(
        response.status,
        'Sinch returned malformed message status'
      );
    }
    return {
      messageId: payload.message_id,
      status: payload.status,
      statusCode:
        typeof payload.status_code === 'number'
          ? payload.status_code
          : null
    };
  }

  async checkConnection(): Promise<{ kind: 'healthy' }> {
    const response = await this.request('GET', '/v1/replies', '');
    if (response.status !== 200) this.throwForResponse(response);
    return { kind: 'healthy' };
  }

  async checkReplies(accountId?: string): Promise<SinchReplyEvent[]> {
    const response = await this.request('GET', '/v1/replies', '', accountId);
    if (response.status !== 200) this.throwForResponse(response);
    try {
      const payload = JSON.parse(response.body) as unknown;
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        !Array.isArray((payload as { replies?: unknown }).replies)
      ) {
        throw new Error('Malformed replies response');
      }
      return (payload as { replies: unknown[] }).replies.map((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('Malformed reply');
        }
        return parseSinchReply(value as Record<string, unknown>);
      });
    } catch (error) {
      throw new SinchTransientFailure(
        response.status,
        error instanceof Error
          ? `Sinch returned malformed replies: ${error.message}`
          : 'Sinch returned malformed replies'
      );
    }
  }

  async confirmReplies(replyIds: string[], accountId?: string): Promise<void> {
    if (replyIds.length === 0) return;
    const response = await this.request(
      'POST',
      '/v1/replies/confirmed',
      JSON.stringify({ reply_ids: replyIds }),
      accountId
    );
    if (![200, 202, 204].includes(response.status)) {
      this.throwForResponse(response);
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: string,
    accountId?: string
  ): Promise<HttpResponse> {
    const date = this.options.clock.now().toUTCString();
    const signature = signSinchRequest({
      apiKey: this.options.credentials.apiKey,
      apiSecret: this.options.credentials.apiSecret,
      method,
      path,
      date,
      body
    });
    return this.options.http.request({
      method,
      url: `${this.baseUrl}${path}`,
      headers: {
        Authorization: signature.authorization,
        Date: date,
        ...(accountId === undefined ? {} : { Account: accountId }),
        ...(signature.contentMd5 === undefined
          ? {}
          : {
              'Content-MD5': signature.contentMd5,
              'Content-Type': 'application/json'
            }),
        Accept: 'application/json'
      },
      ...(body === '' ? {} : { body })
    });
  }

  private throwForResponse(response: HttpResponse): never {
    const message = errorMessage(response);
    if (response.status === 400) {
      throw new SinchValidationFailure(message);
    }
    if (response.status === 401) {
      throw new SinchAuthenticationFailure(message);
    }
    if (response.status === 422) {
      throw new SinchPermanentSubmissionFailure(message);
    }
    if (response.status === 429) {
      throw new SinchRateLimited(
        headerNumber(response.headers, 'retry-after'),
        message
      );
    }
    if (response.status >= 500) {
      throw new SinchTransientFailure(response.status, message);
    }
    throw new SinchPermanentSubmissionFailure(message);
  }
}
