import {
  createRetellWebhookHandler
} from '../../../../server/webhook-handlers.js';
import {
  getCommonWebhookDependencies,
  getRetellWebhookApiKey
} from '../../../../server/webhook-runtime.js';

export async function POST(request: Request): Promise<Response> {
  const common = await getCommonWebhookDependencies();
  const handler = createRetellWebhookHandler({
    ...common,
    apiKey: await getRetellWebhookApiKey(common.organisationId),
    clock: { now: () => new Date() }
  });
  return handler(request);
}
