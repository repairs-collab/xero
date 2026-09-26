import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { XeroClient } from './client.js';
import type { XeroTokenProvider } from './token-cache.js';
import {
  XeroEmailPermanentFailure,
  XeroTransientFailure
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

const tokenProvider: XeroTokenProvider = {
  getAccessToken: () => Promise.resolve('access-token')
};

const rawInvoice = (index = 1) => ({
  InvoiceID: `invoice-${index}`,
  InvoiceNumber: `INV-${index}`,
  Contact: {
    ContactID: 'contact-1',
    Name: 'Example Customer'
  },
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  DateString: '2026-08-01T00:00:00',
  DueDateString: '2026-08-31T00:00:00',
  AmountDue: '120.5000',
  CurrencyCode: 'AUD',
  UpdatedDateUTC: '2026-09-18T00:00:00Z'
});

const rawContact = (index: number) => ({
  ContactID: `contact-${index}`,
  Name: `Customer ${index}`,
  ContactStatus: 'ACTIVE',
  EmailAddress: `accounts-${index}@example.invalid`,
  Phones: [{ PhoneType: 'MOBILE', PhoneNumber: '0400 000 000' }]
});

const createClient = (http: HttpClient) =>
  new XeroClient({
    http,
    tokenProvider,
    baseUrl: 'https://api.xero.test/api.xro/2.0'
  });

describe('XeroClient request contract', () => {
  it('does not send xero-tenant-id for a Custom Connection', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: { 'x-minlimit-remaining': '57' },
      body: JSON.stringify({ Invoices: [rawInvoice()] })
    });
    const client = createClient(http);

    await client.getInvoice('invoice-id');

    expect(http.requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      Accept: 'application/json'
    });
    expect(http.requests[0]?.headers).not.toHaveProperty('xero-tenant-id');
  });

  it('maps a 204 invoice email response to accepted', async () => {
    const http = new FakeHttpClient();
    http.responses.push({ status: 204, headers: {}, body: '' });

    await expect(createClient(http).emailInvoice('invoice-id')).resolves.toEqual(
      { kind: 'accepted' }
    );
  });

  it('maps an invoice email 400 to a permanent failure', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 400,
      headers: {},
      body: '{"Message":"Invoice cannot be emailed"}'
    });

    await expect(
      createClient(http).emailInvoice('invoice-id')
    ).rejects.toBeInstanceOf(XeroEmailPermanentFailure);
  });

  it('maps 429 and Retry-After to XeroRateLimited', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 429,
      headers: {
        'retry-after': '22135',
        'x-daylimit-remaining': '0',
        'x-rate-limit-problem': 'day'
      },
      body: ''
    });

    await expect(createClient(http).getInvoice('invoice-id')).rejects.toMatchObject(
      {
        name: 'XeroRateLimited',
        retryAfterSeconds: 22135,
        dailyRemaining: 0,
        problem: 'day'
      }
    );
  });

  it('pauses all Xero requests until Retry-After expires', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 429,
        headers: {
          'retry-after': '22135',
          'x-daylimit-remaining': '0',
          'x-rate-limit-problem': 'day'
        },
        body: ''
      },
      {
        status: 200,
        headers: { 'x-daylimit-remaining': '999' },
        body: JSON.stringify({ Invoices: [rawInvoice()] })
      }
    );
    let now = new Date('2026-09-26T00:00:00.000Z');
    const client = new XeroClient({
      http,
      tokenProvider,
      baseUrl: 'https://api.xero.test/api.xro/2.0',
      clock: { now: () => now }
    });

    await expect(client.getInvoice('invoice-id')).rejects.toMatchObject({
      retryAfterSeconds: 22_135,
      problem: 'day'
    });
    await expect(client.getOrganisation()).rejects.toMatchObject({
      retryAfterSeconds: 22_135,
      problem: 'day'
    });
    expect(http.requests).toHaveLength(1);

    now = new Date(now.getTime() + 22_135_000);
    await expect(client.getInvoice('invoice-id')).resolves.toMatchObject({
      data: { id: 'invoice-1' }
    });
    expect(http.requests).toHaveLength(2);
  });

  it('maps 5xx responses to a transient failure', async () => {
    const http = new FakeHttpClient();
    http.responses.push({ status: 503, headers: {}, body: '' });

    await expect(
      createClient(http).getOrganisation()
    ).rejects.toBeInstanceOf(XeroTransientFailure);
  });
});

describe('XeroClient data operations', () => {
  it('loads unique contacts in batches of 100 IDs', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '55' },
        body: JSON.stringify({
          Contacts: Array.from({ length: 100 }, (_, index) =>
            rawContact(index + 1)
          )
        })
      },
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '54' },
        body: JSON.stringify({ Contacts: [rawContact(101)] })
      }
    );
    const ids = [
      ...Array.from({ length: 101 }, (_, index) => `contact-${index + 1}`),
      'contact-1'
    ];

    const result = await createClient(http).listContacts(ids);

    expect(result.data).toHaveLength(101);
    expect(result.rateLimit.remaining).toBe(54);
    expect(http.requests).toHaveLength(2);
    expect(
      new URL(http.requests[0]?.url ?? '').searchParams.get('IDs')?.split(',')
    ).toHaveLength(100);
    expect(
      new URL(http.requests[1]?.url ?? '').searchParams.get('IDs')
    ).toBe('contact-101');
  });

  it('pages outstanding invoices with the optimised Xero filters', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '55' },
        body: JSON.stringify({
          Invoices: Array.from({ length: 100 }, (_, index) =>
            rawInvoice(index + 1)
          )
        })
      },
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '54' },
        body: JSON.stringify({ Invoices: [rawInvoice(101)] })
      },
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '53' },
        body: JSON.stringify({ Invoices: [] })
      }
    );

    const result = await createClient(http).listOutstandingInvoices();

    expect(result.data).toHaveLength(101);
    expect(result.data[0]).toMatchObject({
      id: 'invoice-1',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: '120.5000'
    });
    expect(result.rateLimit.remaining).toBe(54);
    expect(http.requests).toHaveLength(2);
    const firstUrl = new URL(http.requests[0]?.url ?? '');
    expect(firstUrl.searchParams.get('summaryOnly')).toBe('true');
    expect(firstUrl.searchParams.get('page')).toBe('1');
    expect(firstUrl.searchParams.get('where')).toBe(
      'Type=="ACCREC" AND Status=="AUTHORISED" AND AmountDue>0'
    );
    expect(new URL(http.requests[1]?.url ?? '').searchParams.get('page')).toBe(
      '2'
    );
  });

  it("stops invoice pagination at Xero's reported final page", async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '55' },
        body: JSON.stringify({
          Invoices: [rawInvoice(1)],
          pagination: {
            page: 1,
            pageSize: 100,
            pageCount: 1,
            itemCount: 1
          }
        })
      },
      {
        status: 404,
        headers: {},
        body: ''
      }
    );

    const result = await createClient(http).listOutstandingInvoices();

    expect(result.data).toHaveLength(1);
    expect(result.rateLimit.remaining).toBe(55);
    expect(http.requests).toHaveLength(1);
  });

  it('stops invoice pagination on a partial page when metadata is omitted', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '55' },
        body: JSON.stringify({ Invoices: [rawInvoice(1)] })
      },
      {
        status: 404,
        headers: {},
        body: ''
      }
    );

    const result = await createClient(http).listOutstandingInvoices();

    expect(result.data).toHaveLength(1);
    expect(result.rateLimit.remaining).toBe(55);
    expect(http.requests).toHaveLength(1);
    expect(
      new URL(http.requests[0]?.url ?? '').searchParams.get('pageSize')
    ).toBe('100');
  });

  it('treats a later-page 404 as the end of invoice pagination', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 200,
        headers: { 'x-minlimit-remaining': '55' },
        body: JSON.stringify({
          Invoices: Array.from({ length: 100 }, (_, index) =>
            rawInvoice(index + 1)
          )
        })
      },
      {
        status: 404,
        headers: {},
        body: ''
      }
    );

    const result = await createClient(http).listOutstandingInvoices();

    expect(result.data).toHaveLength(100);
    expect(result.rateLimit.remaining).toBe(55);
    expect(http.requests).toHaveLength(2);
  });

  it('still surfaces a first-page 404 from Xero', async () => {
    const http = new FakeHttpClient();
    http.responses.push({ status: 404, headers: {}, body: '' });

    await expect(
      createClient(http).listOutstandingInvoices()
    ).rejects.toMatchObject({ name: 'XeroRequestFailure', status: 404 });
    expect(http.requests).toHaveLength(1);
  });

  it('uses If-Modified-Since for an incremental invoice scan', async () => {
    const http = new FakeHttpClient();
    http.responses.push({
      status: 200,
      headers: {},
      body: JSON.stringify({ Invoices: [] })
    });

    await createClient(http).listOutstandingInvoices({
      ifModifiedSince: '2026-09-17T23:58:00.000Z'
    });

    expect(http.requests[0]?.headers).toMatchObject({
      'If-Modified-Since': '2026-09-17T23:58:00.000Z'
    });
  });

  it('maps organisation, contact, and online invoice URL responses', async () => {
    const http = new FakeHttpClient();
    http.responses.push(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          Organisations: [
            {
              OrganisationID: 'organisation-1',
              Name: 'Example Organisation',
              BaseCurrency: 'AUD',
              Timezone: 'AUSEASTERNSTANDARDTIME'
            }
          ]
        })
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          Contacts: [
            {
              ContactID: 'contact-1',
              Name: 'Example Customer',
              ContactStatus: 'ACTIVE',
              EmailAddress: 'accounts@example.invalid',
              Phones: [
                { PhoneType: 'MOBILE', PhoneNumber: '0400 000 000' }
              ]
            }
          ]
        })
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          OnlineInvoices: [
            { OnlineInvoiceUrl: 'https://in.xero.com/example' }
          ]
        })
      }
    );
    const client = createClient(http);

    await expect(client.getOrganisation()).resolves.toMatchObject({
      data: { id: 'organisation-1', baseCurrency: 'AUD' }
    });
    await expect(client.getContact('contact-1')).resolves.toMatchObject({
      data: {
        id: 'contact-1',
        active: true,
        phones: ['0400 000 000'],
        phoneCandidates: [
          { type: 'MOBILE', number: '0400 000 000' }
        ]
      }
    });
    await expect(
      client.getOnlineInvoiceUrl('invoice-1')
    ).resolves.toMatchObject({
      data: 'https://in.xero.com/example'
    });
  });
});
