import {
  createXeroWebhookHandler
} from '../../../../server/webhook-handlers.js';
import {
  getCommonWebhookDependencies
} from '../../../../server/webhook-runtime.js';

export async function POST(request: Request): Promise<Response> {
  const webhookKey = process.env.XERO_WEBHOOK_KEY;
  if (webhookKey === undefined) throw new Error('XERO_WEBHOOK_KEY is required');
  const handler = createXeroWebhookHandler({
    ...(await getCommonWebhookDependencies()),
    webhookKey
  });
  return handler(request);
}
