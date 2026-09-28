import { and, eq, sql } from 'drizzle-orm';

import type { Database, DbTransaction } from '../connection.js';
import {
  organisations,
  type OperationalState,
  type RolloutScope
} from '../schema/organisation.js';

type Executor = Database | DbTransaction;

export interface CompareAndSetOperationalStateInput {
  organisationId: string;
  expectedState: OperationalState;
  expectedVersion: number;
  nextState: OperationalState;
  maintenanceMode?: boolean;
  rolloutScope?: RolloutScope;
  sendMode?: 'dry-run' | 'live';
  liveSendAcknowledged?: boolean;
  now: Date;
}

export class PostgresOrganisationSafetyRepository {
  constructor(private readonly database: Database) {}

  async assertOperationalMutationAllowed(
    executor: Executor,
    organisationId: string
  ): Promise<typeof organisations.$inferSelect> {
    const [organisation] = await executor
      .select()
      .from(organisations)
      .where(eq(organisations.id, organisationId))
      .for('update')
      .limit(1);
    if (organisation === undefined) throw new Error('ORGANISATION_NOT_FOUND');
    if (organisation.maintenanceMode) {
      throw new Error('OPERATIONAL_MAINTENANCE');
    }
    return organisation;
  }

  async compareAndSetOperationalState(
    executor: Executor,
    input: CompareAndSetOperationalStateInput
  ): Promise<typeof organisations.$inferSelect> {
    const [updated] = await executor
      .update(organisations)
      .set({
        operationalState: input.nextState,
        operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`,
        ...(input.maintenanceMode === undefined
          ? {}
          : { maintenanceMode: input.maintenanceMode }),
        ...(input.rolloutScope === undefined
          ? {}
          : { rolloutScope: input.rolloutScope }),
        ...(input.sendMode === undefined ? {} : { sendMode: input.sendMode }),
        ...(input.liveSendAcknowledged === undefined
          ? {}
          : { liveSendAcknowledged: input.liveSendAcknowledged }),
        updatedAt: input.now
      })
      .where(
        and(
          eq(organisations.id, input.organisationId),
          eq(organisations.operationalState, input.expectedState),
          eq(organisations.operationalStateVersion, input.expectedVersion)
        )
      )
      .returning();
    if (updated === undefined) throw new Error('OPERATIONAL_STATE_CONFLICT');
    return updated;
  }
}
