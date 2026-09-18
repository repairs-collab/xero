import { and, eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  outboundMessages,
  type OutboundStatus
} from '../schema/messaging.js';

export type ClaimResult =
  | { kind: 'claimed'; outboundId: string }
  | {
      kind: 'already-exists';
      outboundId: string;
      status: OutboundStatus;
    };

export interface ClaimOutboundIntentInput {
  organisationId: string;
  stageInstanceId: string;
  channel: 'SMS' | 'XERO_EMAIL';
  recipientKey: string;
  sourceVersion: number;
  idempotencyKey: string;
}

export interface ChaseRepository {
  claimOutboundIntent(input: ClaimOutboundIntentInput): Promise<ClaimResult>;
}

export class PostgresChaseRepository implements ChaseRepository {
  constructor(private readonly database: Database) {}

  async claimOutboundIntent(
    input: ClaimOutboundIntentInput
  ): Promise<ClaimResult> {
    return this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(outboundMessages)
        .values({
          ...input,
          status: 'PENDING'
        })
        .onConflictDoNothing({
          target: [
            outboundMessages.organisationId,
            outboundMessages.idempotencyKey
          ]
        })
        .returning({
          id: outboundMessages.id
        });

      const claimed = inserted[0];
      if (claimed !== undefined) {
        return { kind: 'claimed', outboundId: claimed.id };
      }

      const existing = await transaction
        .select({
          id: outboundMessages.id,
          status: outboundMessages.status
        })
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.organisationId, input.organisationId),
            eq(outboundMessages.idempotencyKey, input.idempotencyKey)
          )
        )
        .for('update')
        .limit(1);

      const row = existing[0];
      if (row === undefined) {
        throw new Error('Outbound claim conflict could not be resolved');
      }

      return {
        kind: 'already-exists',
        outboundId: row.id,
        status: row.status
      };
    });
  }
}
