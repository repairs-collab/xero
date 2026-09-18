import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

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
  recordOnceWithId(input: RecordWebhookInput): Promise<{
    kind: 'recorded' | 'duplicate';
    id: string;
  }>;
}

export class PostgresWebhookRepository implements WebhookRepository {
  constructor(private readonly database: Database) {}

  async recordOnce(
    input: RecordWebhookInput
  ): Promise<'recorded' | 'duplicate'> {
    return (await this.recordOnceWithId(input)).kind;
  }

  async recordOnceWithId(input: RecordWebhookInput): Promise<{
    kind: 'recorded' | 'duplicate';
    id: string;
  }> {
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

    const created = inserted[0];
    if (created !== undefined) return { kind: 'recorded', id: created.id };

    const [existing] = await this.database
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.organisationId, input.organisationId),
          eq(webhookEvents.provider, input.provider),
          eq(webhookEvents.providerEventKey, providerEventKey)
        )
      )
      .limit(1);
    if (existing === undefined) {
      throw new Error('Webhook conflict could not be resolved');
    }
    return { kind: 'duplicate', id: existing.id };
  }
}
