import {
  createSinchWebhookHandler
} from '../../../../server/webhook-handlers.js';
import {
  getCommonWebhookDependencies,
  getSinchPublicKeys,
  getSinchWebhookToken
} from '../../../../server/webhook-runtime.js';

export async function POST(request: Request): Promise<Response> {
  const handler = createSinchWebhookHandler({
    ...(await getCommonWebhookDependencies()),
    publicKeys: getSinchPublicKeys(),
    sharedToken: getSinchWebhookToken()
  });
  return handler(request);
}
