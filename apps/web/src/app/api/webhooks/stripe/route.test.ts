import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleWebhook = vi.fn();

vi.mock('../../../../server/runtime.js', () => ({
  getSubscriptionService: () => Promise.resolve({ handleWebhook })
}));

describe('Stripe webhook route', () => {
  beforeEach(() => {
    handleWebhook.mockReset();
  });

  it('passes the exact raw body and signature to the subscription service', async () => {
    handleWebhook.mockResolvedValue('APPLIED');
    const { POST } = await import('./route.js');
    const body = '{ "id": "evt_one", "spacing": true }';

    const response = await POST(
      new Request('https://ap.motts.com.au/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1794201600,v1=signature' },
        body
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, outcome: 'APPLIED' });
    expect(handleWebhook).toHaveBeenCalledOnce();
    const [rawBody, signature] = handleWebhook.mock.calls[0] as [Buffer, string];
    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(rawBody.toString('utf8')).toBe(body);
    expect(signature).toBe('t=1794201600,v1=signature');
  });

  it('rejects a missing signature without processing the body', async () => {
    const { POST } = await import('./route.js');
    const response = await POST(
      new Request('https://ap.motts.com.au/api/webhooks/stripe', {
        method: 'POST',
        body: '{}'
      })
    );

    expect(response.status).toBe(400);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
