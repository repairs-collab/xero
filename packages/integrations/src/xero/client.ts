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
  clock?: { now(): Date };
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

const textHeader = (
  headers: Record<string, string>,
  name: string
): string | null => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  const value = entry?.[1].trim();
  return value === undefined || value === '' ? null : value.toLowerCase();
};

const rateLimitFrom = (
  headers: Record<string, string>
): XeroRateLimit => ({
  limit: numericHeader(headers, 'x-minlimit-limit'),
  remaining: numericHeader(headers, 'x-minlimit-remaining'),
  dailyRemaining: numericHeader(headers, 'x-daylimit-remaining'),
  problem: textHeader(headers, 'x-rate-limit-problem'),
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
  private rateLimitBlock:
    | {
        until: number;
        dailyRemaining: number | null;
        problem: string | null;
      }
    | undefined;

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
      dailyRemaining: null,
      problem: null,
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
        pagination?: {
          page: number;
          pageSize: number;
          pageCount: number;
          itemCount: number;
        };
      }>(
        'GET',
        `/Invoices?${search.toString()}`,
        options.ifModifiedSince === undefined
          ? {}
          : { 'If-Modified-Since': options.ifModifiedSince }
      );
      invoices.push(...response.data.Invoices.map(mapXeroInvoice));
      lastRateLimit = response.rateLimit;
      if (
        response.data.pagination !== undefined &&
        response.data.pagination.page >= response.data.pagination.pageCount
      ) {
        break;
      }
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

  async listContacts(
    contactIds: string[]
  ): Promise<XeroResult<XeroContact[]>> {
    const uniqueIds = [...new Set(contactIds)];
    const contacts: XeroContact[] = [];
    let lastRateLimit: XeroRateLimit = {
      limit: null,
      remaining: null,
      dailyRemaining: null,
      problem: null,
      retryAfterSeconds: null
    };

    for (let index = 0; index < uniqueIds.length; index += 100) {
      const search = new URLSearchParams({
        IDs: uniqueIds.slice(index, index + 100).join(','),
        pageSize: '100'
      });
      const response = await this.requestJson<{
        Contacts: RawXeroContact[];
      }>('GET', `/Contacts?${search.toString()}`);
      contacts.push(...response.data.Contacts.map(mapXeroContact));
      lastRateLimit = response.rateLimit;
    }

    return { data: contacts, rateLimit: lastRateLimit };
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
    const now = (this.options.clock?.now() ?? new Date()).getTime();
    if (this.rateLimitBlock !== undefined) {
      const retryAfterSeconds = Math.ceil(
        (this.rateLimitBlock.until - now) / 1000
      );
      if (retryAfterSeconds > 0) {
        throw new XeroRateLimited(
          retryAfterSeconds,
          this.rateLimitBlock.dailyRemaining,
          this.rateLimitBlock.problem
        );
      }
      this.rateLimitBlock = undefined;
    }
    const accessToken = await this.options.tokenProvider.getAccessToken();
    const response = await this.options.http.request({
      method,
      url: `${this.baseUrl}${path}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...headers
      }
    });
    if (response.status === 429) {
      const retryAfterSeconds = numericHeader(
        response.headers,
        'retry-after'
      );
      if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
        this.rateLimitBlock = {
          until: now + retryAfterSeconds * 1000,
          dailyRemaining: numericHeader(
            response.headers,
            'x-daylimit-remaining'
          ),
          problem: textHeader(response.headers, 'x-rate-limit-problem')
        };
      }
    }
    return response;
  }

  private throwForResponse(response: HttpResponse): void {
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 401) throw new XeroAuthenticationFailure();
    if (response.status === 429) {
      throw new XeroRateLimited(
        numericHeader(response.headers, 'retry-after'),
        numericHeader(response.headers, 'x-daylimit-remaining'),
        textHeader(response.headers, 'x-rate-limit-problem')
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
