import {
  createSinchWebhookHandler
} from '../../../../server/webhook-handlers.js';
import {
  getCommonWebhookDependencies,
  getSinchPublicKeys
} from '../../../../server/webhook-runtime.js';

export async function POST(request: Request): Promise<Response> {
  const handler = createSinchWebhookHandler({
    ...(await getCommonWebhookDependencies()),
    publicKeys: getSinchPublicKeys()
  });
  return handler(request);
}
