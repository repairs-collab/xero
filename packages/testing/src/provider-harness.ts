import {
  createHmac,
  createSign,
  generateKeyPairSync,
  randomUUID
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';

export type ProviderOutcome =
  | 'accepted'
  | 'rate-limit'
  | 'rejected'
  | 'timeout-before-dispatch'
  | 'timeout-after-dispatch';

export interface HarnessCall {
  method: string;
  path: string;
  body: unknown;
  recordedAt: string;
}

export interface HarnessInvoice {
  id: string;
  contactId: string;
  invoiceNumber: string;
  dueDate: string;
  amountDue: string;
  status?: 'AUTHORISED' | 'PAID' | 'VOIDED';
}

export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

export interface SignedSinchWebhook extends SignedWebhook {
  canonicalBytes: Buffer;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const parseBody = (body: string): unknown => {
  if (body === '') return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};

const json = (
  response: ServerResponse,
  status: number,
  value: Record<string, unknown>
): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

const applyOutcome = (
  outcome: ProviderOutcome,
  response: ServerResponse,
  accepted: Record<string, unknown>,
  recordAfterDispatch: () => void
): void => {
  if (outcome === 'timeout-before-dispatch') {
    response.destroy();
    return;
  }
  if (outcome === 'timeout-after-dispatch') {
    recordAfterDispatch();
    response.destroy();
    return;
  }
  recordAfterDispatch();
  if (outcome === 'rate-limit') {
    response.setHeader('retry-after', '2');
    json(response, 429, { error: 'rate_limited' });
  } else if (outcome === 'rejected') {
    json(response, 400, { error: 'rejected' });
  } else {
    json(response, 202, accepted);
  }
};

export class ProviderHarness {
  readonly baseUrl: string;
  readonly xero: {
    seedInvoice: (invoice: HarnessInvoice) => void;
    markPaid: (invoiceId: string) => void;
    onEmail: (outcome: ProviderOutcome) => void;
    invoiceWebhook: (input: { invoiceId: string }) => SignedWebhook;
  };
  readonly sinch: {
    publicKeyPem: string;
    keyId: string;
    onSubmit: (outcome: ProviderOutcome) => void;
    replyWebhook: (input: {
      sourceNumber: string;
      destinationNumber: string;
      content: string;
      path: string;
    }) => SignedSinchWebhook;
    optOutWebhook: (input: {
      sourceNumber: string;
      destinationNumber: string;
      path: string;
    }) => SignedSinchWebhook;
    deliveryWebhook: (input: {
      messageId: string;
      status?: 'DELIVERED_DR' | 'FAILED_DR' | 'REJECTED_DR';
      path: string;
    }) => SignedSinchWebhook;
    lastMessageId: () => string | undefined;
  };

  private currentTime: Date;
  private readonly server: Server;
  private readonly recordedCalls: HarnessCall[] = [];
  private readonly invoices = new Map<string, HarnessInvoice>();
  private sinchOutcome: ProviderOutcome = 'accepted';
  private xeroEmailOutcome: ProviderOutcome = 'accepted';
  private sinchMessageCount = 0;
  private lastSinchMessageId: string | undefined;

  private constructor(
    server: Server,
    baseUrl: string,
    now: Date,
    xeroWebhookKey: string,
    private readonly sinchPrivateKey: string,
    sinchPublicKey: string,
    sinchKeyId: string
  ) {
    this.server = server;
    this.baseUrl = baseUrl;
    this.currentTime = now;
    this.xero = {
      seedInvoice: (invoice) => this.invoices.set(invoice.id, { ...invoice }),
      markPaid: (invoiceId) => {
        const invoice = this.invoices.get(invoiceId);
        if (invoice === undefined) throw new Error(`Unknown invoice ${invoiceId}`);
        this.invoices.set(invoiceId, { ...invoice, amountDue: '0.00', status: 'PAID' });
      },
      onEmail: (outcome) => {
        this.xeroEmailOutcome = outcome;
      },
      invoiceWebhook: ({ invoiceId }) => {
        const body = JSON.stringify({
          events: [
            {
              resourceId: invoiceId,
              eventCategory: 'INVOICE',
              eventType: 'UPDATE',
              eventDateUtc: this.currentTime.toISOString()
            }
          ]
        });
        return {
          body,
          headers: {
            'content-type': 'application/json',
            'x-xero-signature': createHmac('sha256', xeroWebhookKey)
              .update(body)
              .digest('base64')
          }
        };
      }
    };
    this.sinch = {
      publicKeyPem: sinchPublicKey,
      keyId: sinchKeyId,
      onSubmit: (outcome) => {
        this.sinchOutcome = outcome;
      },
      replyWebhook: (input) =>
        this.signSinchWebhook(
          input.path,
          {
            event_type: 'RECEIVED_SMS',
            reply_id: randomUUID(),
            source_number: input.sourceNumber,
            destination_number: input.destinationNumber,
            received_date: this.currentTime.toISOString(),
            content: input.content,
            metadata: {}
          },
          sinchKeyId
        ),
      optOutWebhook: (input) =>
        this.signSinchWebhook(
          input.path,
          {
            event_type: 'OPT_OUT_SMS',
            reply_id: randomUUID(),
            source_number: input.sourceNumber,
            destination_number: input.destinationNumber,
            received_date: this.currentTime.toISOString(),
            content: 'STOP',
            metadata: {}
          },
          sinchKeyId
        ),
      deliveryWebhook: (input) =>
        this.signSinchWebhook(
          input.path,
          {
            event_type: input.status ?? 'DELIVERED_DR',
            message_id: input.messageId,
            received_date: this.currentTime.toISOString()
          },
          sinchKeyId
        ),
      lastMessageId: () => this.lastSinchMessageId
    };
  }

  static async start(options: {
    now: string;
    xeroWebhookKey?: string;
  }): Promise<ProviderHarness> {
    const now = new Date(options.now);
    if (!Number.isFinite(now.getTime())) throw new Error('Harness time must be valid ISO-8601');
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = 'harness-sinch-key';
    const state: { harness?: ProviderHarness } = {};
    const server = createServer((request, response) => {
      void state.harness?.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Provider harness did not bind a TCP port');
    }
    const harness = new ProviderHarness(
      server,
      `http://127.0.0.1:${address.port}`,
      now,
      options.xeroWebhookKey ?? 'xero-test-webhook-key',
      privateKey,
      publicKey,
      keyId
    );
    state.harness = harness;
    return harness;
  }

  now(): Date {
    return new Date(this.currentTime);
  }

  advanceBy(input: { days?: number; milliseconds?: number }): void {
    const milliseconds =
      (input.days ?? 0) * 86_400_000 + (input.milliseconds ?? 0);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error('Harness clock can only advance by a non-negative duration');
    }
    this.currentTime = new Date(this.currentTime.getTime() + milliseconds);
  }

  calls(): HarnessCall[] {
    return this.recordedCalls.map((call) => ({ ...call }));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private record(method: string, url: URL, body: string): void {
    this.recordedCalls.push({
      method,
      path: url.pathname,
      body: parseBody(body),
      recordedAt: this.currentTime.toISOString()
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', this.baseUrl);
      const body = await readBody(request);
      if (url.pathname === '/connect/token' && method === 'POST') {
        this.record(method, url, body);
        json(response, 200, {
          access_token: 'harness-access-token',
          token_type: 'Bearer',
          expires_in: 1800,
          scope: 'accounting.invoices accounting.contacts.read accounting.settings.read'
        });
        return;
      }
      if (url.pathname === '/api.xro/2.0/Invoices' && method === 'GET') {
        this.record(method, url, body);
        json(response, 200, {
          Invoices: (url.searchParams.get('page') === null || url.searchParams.get('page') === '1')
            ? [...this.invoices.values()].map((invoice) => ({
            InvoiceID: invoice.id,
            InvoiceNumber: invoice.invoiceNumber,
            Contact: { ContactID: invoice.contactId, Name: 'Harness customer' },
            Type: 'ACCREC',
            Status: invoice.status ?? 'AUTHORISED',
            DateString: invoice.dueDate,
            DueDateString: invoice.dueDate,
            AmountDue: Number(invoice.amountDue),
            CurrencyCode: 'AUD'
          }))
            : []
        });
        return;
      }
      if (/^\/api\.xro\/2\.0\/Invoices\/[^/]+\/Email$/.test(url.pathname) && method === 'POST') {
        if (this.xeroEmailOutcome === 'timeout-before-dispatch') {
          response.destroy();
        } else if (this.xeroEmailOutcome === 'timeout-after-dispatch') {
          this.record(method, url, body);
          response.destroy();
        } else {
          this.record(method, url, body);
          if (this.xeroEmailOutcome === 'rate-limit') {
            response.setHeader('retry-after', '2');
            json(response, 429, { error: 'rate_limited' });
          } else if (this.xeroEmailOutcome === 'rejected') {
            json(response, 400, { Message: 'Invoice cannot be emailed' });
          } else {
            response.writeHead(204);
            response.end();
          }
        }
        return;
      }
      if (url.pathname === '/v1/messages' && method === 'POST') {
        const messageId = `sinch-message-${this.sinchMessageCount + 1}`;
        applyOutcome(this.sinchOutcome, response, {
          messages: [{ message_id: messageId, status: 'ENROUTE' }]
        }, () => {
          this.sinchMessageCount += 1;
          this.lastSinchMessageId = messageId;
          this.record(method, url, body);
        });
        return;
      }
      if (url.pathname === '/v1/webhooks/messages' && method === 'GET') {
        this.record(method, url, body);
        json(response, 200, { webhooks: [] });
        return;
      }
      this.record(method, url, body);
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : 'harness_failure'
      });
    }
  }

  private signSinchWebhook(
    path: string,
    payload: Record<string, unknown>,
    keyId: string
  ): SignedSinchWebhook {
    const body = JSON.stringify(payload);
    const date = this.currentTime.toUTCString();
    const canonicalBytes = Buffer.concat([
      Buffer.from(`POST ${path} HTTP/1.1\n${date}\n`, 'utf8'),
      Buffer.from(body, 'utf8')
    ]);
    const signer = createSign('RSA-SHA512');
    signer.update(canonicalBytes);
    signer.end();
    return {
      body,
      canonicalBytes,
      headers: {
        'content-type': 'application/json',
        date,
        'x-messagemedia-signature': signer
          .sign(this.sinchPrivateKey)
          .toString('base64'),
        'x-messagemedia-digest-type': 'SHA-512',
        'x-messagemedia-cipher-type': 'RSA',
        'x-messagemedia-key-id': keyId
      }
    };
  }
}
