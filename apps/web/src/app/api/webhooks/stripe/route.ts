import { StripeWebhookSignatureFailure } from '@bc5000/integrations/stripe';

import { getSubscriptionService } from '../../../../server/runtime.js';
import { SubscriptionFailure } from '../../../../server/subscription-service.js';

const response = (body: Record<string, unknown>, status: number): Response =>
  Response.json(body, { status });

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature')?.trim();
  if (!signature) return response({ received: false }, 400);

  const rawBody = Buffer.from(await request.arrayBuffer());
  try {
    const service = await getSubscriptionService();
    const outcome = await service.handleWebhook(rawBody, signature);
    return response({ received: true, outcome }, 200);
  } catch (error) {
    if (
      error instanceof StripeWebhookSignatureFailure ||
      error instanceof SubscriptionFailure
    ) {
      return response({ received: false }, 400);
    }
    throw error;
  }
}
