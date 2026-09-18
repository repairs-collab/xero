import { createHmac, createVerify } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { ProviderHarness } from './provider-harness.js';

describe('ProviderHarness', () => {
  let harness: ProviderHarness | undefined;

  afterEach(async () => {
    await harness?.stop();
  });

  it('serves deterministic Xero and Sinch responses and records safe calls', async () => {
    harness = await ProviderHarness.start({
      now: '2026-09-18T00:00:00.000Z',
      xeroWebhookKey: 'xero-test-webhook-key'
    });
    harness.xero.seedInvoice({
      id: 'inv-1',
      contactId: 'contact-1',
      invoiceNumber: 'INV-1',
      dueDate: '2026-09-18',
      amountDue: '100.00'
    });
    harness.sinch.onSubmit('accepted');

    const token = await fetch(`${harness.baseUrl}/connect/token`, {
      method: 'POST',
      headers: { authorization: 'Basic secret-that-must-not-be-recorded' }
    });
    const invoices = await fetch(
      `${harness.baseUrl}/api.xro/2.0/Invoices?Statuses=AUTHORISED`
    );
    const submission = await fetch(`${harness.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Basic another-secret' },
      body: JSON.stringify({ content: 'Reminder', destination_number: '+61400000001' })
    });

    expect(await token.json()).toMatchObject({ access_token: 'harness-access-token' });
    expect(await invoices.json()).toMatchObject({ Invoices: [{ InvoiceID: 'inv-1' }] });
    expect(await submission.json()).toMatchObject({
      messages: [{ message_id: 'sinch-message-1', status: 'ENROUTE' }]
    });
    expect(harness.calls()).toEqual([
      expect.objectContaining({ method: 'POST', path: '/connect/token' }),
      expect.objectContaining({ method: 'GET', path: '/api.xro/2.0/Invoices' }),
      expect.objectContaining({ method: 'POST', path: '/v1/messages' })
    ]);
    expect(JSON.stringify(harness.calls())).not.toContain('secret-that-must-not-be-recorded');
  });

  it('creates valid Xero and Sinch webhook signatures and advances its clock', async () => {
    harness = await ProviderHarness.start({
      now: '2026-09-18T00:00:00.000Z',
      xeroWebhookKey: 'xero-test-webhook-key'
    });

    const xero = harness.xero.invoiceWebhook({ invoiceId: 'inv-1' });
    expect(xero.headers['x-xero-signature']).toBe(
      createHmac('sha256', 'xero-test-webhook-key').update(xero.body).digest('base64')
    );

    const sinch = harness.sinch.replyWebhook({
      sourceNumber: '+61400000001',
      destinationNumber: '+61400000002',
      content: 'Can we pay Friday?',
      path: '/api/webhooks/sinch'
    });
    const verifier = createVerify('RSA-SHA512');
    verifier.update(sinch.canonicalBytes);
    verifier.end();
    const signature = sinch.headers['x-messagemedia-signature'];
    expect(signature).toBeDefined();
    expect(
      verifier.verify(
        harness.sinch.publicKeyPem,
        Buffer.from(signature!, 'base64')
      )
    ).toBe(true);

    harness.advanceBy({ days: 7 });
    expect(harness.now().toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it.each([
    ['rate-limit', 429],
    ['rejected', 400],
    ['accepted', 202]
  ] as const)('models a %s Sinch submission', async (outcome, status) => {
    harness = await ProviderHarness.start({ now: '2026-09-18T00:00:00.000Z' });
    harness.sinch.onSubmit(outcome);
    const response = await fetch(`${harness.baseUrl}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Reminder' })
    });
    expect(response.status).toBe(status);
  });
});
