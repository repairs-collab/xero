import { createHash } from 'node:crypto';

import type { Database } from '../client.js';
import { webhookEvents } from '../schema/operations.js';

export interface RecordWebhookInput {
  organisationId: string;
  provider: 'XERO' | 'SINCH';
  providerEventId?: string;
  rawBody: string;
  signatureValid: boolean;
}

export interface WebhookRepository {
  recordOnce(input: RecordWebhookInput): Promise<'recorded' | 'duplicate'>;
}

export class PostgresWebhookRepository implements WebhookRepository {
  constructor(private readonly database: Database) {}

  async recordOnce(
    input: RecordWebhookInput
  ): Promise<'recorded' | 'duplicate'> {
    const bodyHash = createHash('sha256')
      .update(input.rawBody)
      .digest('hex');
    const providerEventKey =
      input.providerEventId ?? `sha256:${bodyHash}`;

    const inserted = await this.database
      .insert(webhookEvents)
      .values({
        organisationId: input.organisationId,
        provider: input.provider,
        providerEventKey,
        providerEventId: input.providerEventId,
        bodyHash,
        signatureValid: input.signatureValid,
        providerPayload: { rawBody: input.rawBody }
      })
      .onConflictDoNothing({
        target: [
          webhookEvents.organisationId,
          webhookEvents.provider,
          webhookEvents.providerEventKey
        ]
      })
      .returning({ id: webhookEvents.id });

    return inserted.length === 1 ? 'recorded' : 'duplicate';
  }
}
