import {
  createSinchWebhookHandler
} from '../../../../server/webhook-handlers.js';
import {
  getSinchWebhookDependencies,
  getSinchPublicKeys,
  getSinchWebhookToken
} from '../../../../server/webhook-runtime.js';

export async function POST(request: Request): Promise<Response> {
  const handler = createSinchWebhookHandler({
    ...(await getSinchWebhookDependencies()),
    publicKeys: getSinchPublicKeys(),
    sharedToken: getSinchWebhookToken()
  });
  return handler(request);
}
