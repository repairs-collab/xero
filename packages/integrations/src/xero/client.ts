import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import {
  mapXeroContact,
  mapXeroInvoice,
  mapXeroOrganisation,
  type RawXeroContact,
  type RawXeroInvoice,
  type RawXeroOrganisation
} from './mappers.js';
import type { XeroTokenProvider } from './token-cache.js';
import {
  XeroAuthenticationFailure,
  XeroEmailPermanentFailure,
  XeroRateLimited,
  XeroRequestFailure,
  XeroTransientFailure,
  type XeroContact,
  type XeroInvoice,
  type XeroOrganisation,
  type XeroRateLimit,
  type XeroResult
} from './types.js';

export interface XeroClientOptions {
  http: HttpClient;
  tokenProvider: XeroTokenProvider;
  baseUrl?: string;
}

export interface ListOutstandingInvoicesOptions {
  ifModifiedSince?: string;
}

interface XeroEnvelope<T> {
  data: T;
  rateLimit: XeroRateLimit;
}

const numericHeader = (
  headers: Record<string, string>,
  name: string
): number | null => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  if (entry === undefined) return null;
  const parsed = Number.parseInt(entry[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const rateLimitFrom = (
  headers: Record<string, string>
): XeroRateLimit => ({
  limit: numericHeader(headers, 'x-minlimit-limit'),
  remaining: numericHeader(headers, 'x-minlimit-remaining'),
  retryAfterSeconds: numericHeader(headers, 'retry-after')
});

const responseMessage = (response: HttpResponse): string => {
  if (response.body === '') return `Xero returned status ${response.status}`;
  try {
    const parsed = JSON.parse(response.body) as {
      Message?: unknown;
      message?: unknown;
    };
    const message = parsed.Message ?? parsed.message;
    return typeof message === 'string' ? message : response.body;
  } catch {
    return response.body;
  }
};

export class XeroClient {
  private readonly baseUrl: string;

  constructor(private readonly options: XeroClientOptions) {
    this.baseUrl = (
      options.baseUrl ?? 'https://api.xero.com/api.xro/2.0'
    ).replace(/\/$/, '');
  }

  async getOrganisation(): Promise<XeroResult<XeroOrganisation>> {
    const response = await this.requestJson<{
      Organisations: RawXeroOrganisation[];
    }>('GET', '/Organisation');
    const organisation = response.data.Organisations[0];
    if (organisation === undefined) {
      throw new XeroRequestFailure(502, 'Xero returned no organisation');
    }
    return {
      data: mapXeroOrganisation(organisation),
      rateLimit: response.rateLimit
    };
  }

  async listOutstandingInvoices(
    options: ListOutstandingInvoicesOptions = {}
  ): Promise<XeroResult<XeroInvoice[]>> {
    const invoices: XeroInvoice[] = [];
    let page = 1;
    let lastRateLimit: XeroRateLimit = {
      limit: null,
      remaining: null,
      retryAfterSeconds: null
    };

    while (true) {
      const search = new URLSearchParams({
        summaryOnly: 'true',
        page: String(page),
        where:
          'Type=="ACCREC" AND Status=="AUTHORISED" AND AmountDue>0'
      });
      const response = await this.requestJson<{
        Invoices: RawXeroInvoice[];
      }>(
        'GET',
        `/Invoices?${search.toString()}`,
        options.ifModifiedSince === undefined
          ? {}
          : { 'If-Modified-Since': options.ifModifiedSince }
      );
      invoices.push(...response.data.Invoices.map(mapXeroInvoice));
      lastRateLimit = response.rateLimit;
      if (response.data.Invoices.length === 0) break;
      page += 1;
    }

    return { data: invoices, rateLimit: lastRateLimit };
  }

  async getInvoice(invoiceId: string): Promise<XeroResult<XeroInvoice>> {
    const response = await this.requestJson<{
      Invoices: RawXeroInvoice[];
    }>('GET', `/Invoices/${encodeURIComponent(invoiceId)}`);
    const invoice = response.data.Invoices[0];
    if (invoice === undefined) {
      throw new XeroRequestFailure(404, 'Xero invoice was not found');
    }
    return {
      data: mapXeroInvoice(invoice),
      rateLimit: response.rateLimit
    };
  }

  async getContact(contactId: string): Promise<XeroResult<XeroContact>> {
    const response = await this.requestJson<{
      Contacts: RawXeroContact[];
    }>('GET', `/Contacts/${encodeURIComponent(contactId)}`);
    const contact = response.data.Contacts[0];
    if (contact === undefined) {
      throw new XeroRequestFailure(404, 'Xero contact was not found');
    }
    return {
      data: mapXeroContact(contact),
      rateLimit: response.rateLimit
    };
  }

  async getOnlineInvoiceUrl(
    invoiceId: string
  ): Promise<XeroResult<string>> {
    const response = await this.requestJson<{
      OnlineInvoices: Array<{ OnlineInvoiceUrl: string }>;
    }>('GET', `/Invoices/${encodeURIComponent(invoiceId)}/OnlineInvoice`);
    const onlineInvoiceUrl = response.data.OnlineInvoices[0]?.OnlineInvoiceUrl;
    if (onlineInvoiceUrl === undefined) {
      throw new XeroRequestFailure(
        502,
        'Xero returned no online invoice URL'
      );
    }
    return { data: onlineInvoiceUrl, rateLimit: response.rateLimit };
  }

  async emailInvoice(
    invoiceId: string
  ): Promise<{ kind: 'accepted' }> {
    const response = await this.request(
      'POST',
      `/Invoices/${encodeURIComponent(invoiceId)}/Email`
    );
    if (response.status === 204) return { kind: 'accepted' };
    if (response.status === 400) {
      throw new XeroEmailPermanentFailure(responseMessage(response));
    }
    this.throwForResponse(response);
    throw new XeroRequestFailure(
      response.status,
      'Unexpected Xero invoice email response'
    );
  }

  private async requestJson<T>(
    method: HttpRequest['method'],
    path: string,
    headers: Record<string, string> = {}
  ): Promise<XeroEnvelope<T>> {
    const response = await this.request(method, path, headers);
    this.throwForResponse(response);
    try {
      return {
        data: JSON.parse(response.body) as T,
        rateLimit: rateLimitFrom(response.headers)
      };
    } catch {
      throw new XeroRequestFailure(
        response.status,
        'Xero returned malformed JSON'
      );
    }
  }

  private async request(
    method: HttpRequest['method'],
    path: string,
    headers: Record<string, string> = {}
  ): Promise<HttpResponse> {
    const accessToken = await this.options.tokenProvider.getAccessToken();
    return this.options.http.request({
      method,
      url: `${this.baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...headers
      }
    });
  }

  private throwForResponse(response: HttpResponse): void {
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 401) throw new XeroAuthenticationFailure();
    if (response.status === 429) {
      throw new XeroRateLimited(
        numericHeader(response.headers, 'retry-after')
      );
    }
    if (response.status >= 500) {
      throw new XeroTransientFailure(
        response.status,
        responseMessage(response)
      );
    }
    throw new XeroRequestFailure(
      response.status,
      responseMessage(response)
    );
  }
}
