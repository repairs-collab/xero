import { afterEach, describe, expect, it } from 'vitest';

import { FetchHttpClient } from '@bc5000/integrations/http';
import { SinchClient, SinchRateLimited } from '@bc5000/integrations/sinch';
import { XeroClient } from '@bc5000/integrations/xero';

import { ProviderHarness } from './provider-harness.js';

describe('provider clients against the deterministic harness', () => {
  let harness: ProviderHarness | undefined;

  afterEach(async () => {
    await harness?.stop();
  });

  it('syncs and emails through Xero without a tenant header', async () => {
    harness = await ProviderHarness.start({ now: '2026-09-18T00:00:00.000Z' });
    harness.xero.seedInvoice({
      id: 'inv-1',
      contactId: 'contact-1',
      invoiceNumber: 'INV-1',
      dueDate: '2026-09-18',
      amountDue: '100.00'
    });
    const client = new XeroClient({
      http: new FetchHttpClient(),
      tokenProvider: { getAccessToken: () => Promise.resolve('test-token') },
      baseUrl: `${harness.baseUrl}/api.xro/2.0`
    });

    const result = await client.listOutstandingInvoices();
    expect(result.data).toEqual([
      expect.objectContaining({ id: 'inv-1', invoiceNumber: 'INV-1' })
    ]);
    await expect(client.emailInvoice('inv-1')).resolves.toEqual({ kind: 'accepted' });
    expect(harness.calls().filter((call) => call.path.endsWith('/Email'))).toHaveLength(1);
  });

  it('submits to Sinch and exposes rate limiting to the worker', async () => {
    harness = await ProviderHarness.start({ now: '2026-09-18T00:00:00.000Z' });
    const client = new SinchClient({
      http: new FetchHttpClient(),
      credentials: { apiKey: 'test-key', apiSecret: 'test-secret' },
      clock: { now: () => harness!.now() },
      baseUrl: harness.baseUrl
    });
    const input = {
      destinationNumber: '+61400000001',
      content: 'Invoice INV-1 is overdue.',
      callbackUrl: 'https://bill-chaser.test/api/webhooks/sinch',
      metadata: { organisationId: 'org-1' }
    };

    await expect(client.sendSms(input)).resolves.toMatchObject({
      kind: 'accepted',
      messageId: 'sinch-message-1'
    });
    harness.sinch.onSubmit('rate-limit');
    await expect(client.sendSms(input)).rejects.toBeInstanceOf(SinchRateLimited);
  });
});
