import { and, eq } from 'drizzle-orm';

import type { Database, DbTransaction } from '../connection.js';
import {
  debtContactClaims,
  type DebtContactChannel
} from '../schema/debt-contact.js';

type Executor = Database | DbTransaction;

export interface DebtContactClaimInput {
  organisationId: string;
  contactId: string;
  localDate: string;
  channel: DebtContactChannel;
  sourceId: string;
  claimedAt: Date;
}

export type DebtContactClaimDecision =
  | {
      kind: 'claimed';
      claim: typeof debtContactClaims.$inferSelect;
    }
  | {
      kind: 'already-claimed';
      claim: typeof debtContactClaims.$inferSelect;
    };

export class PostgresDebtContactRepository {
  constructor(private readonly database: Database) {}

  async claimDebtContact(
    input: DebtContactClaimInput,
    executor: Executor = this.database
  ): Promise<DebtContactClaimDecision> {
    const [claimed] = await executor
      .insert(debtContactClaims)
      .values(input)
      .onConflictDoNothing({
        target: [
          debtContactClaims.organisationId,
          debtContactClaims.contactId,
          debtContactClaims.localDate
        ]
      })
      .returning();
    if (claimed !== undefined) return { kind: 'claimed', claim: claimed };

    const [existing] = await executor
      .select()
      .from(debtContactClaims)
      .where(
        and(
          eq(debtContactClaims.organisationId, input.organisationId),
          eq(debtContactClaims.contactId, input.contactId),
          eq(debtContactClaims.localDate, input.localDate)
        )
      )
      .limit(1);
    if (existing === undefined) throw new Error('DEBT_CONTACT_CLAIM_FAILED');
    return { kind: 'already-claimed', claim: existing };
  }
}
