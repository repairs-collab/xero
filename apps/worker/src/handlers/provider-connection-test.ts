import { and, eq } from 'drizzle-orm';

import {
  auditEvents,
  type Database,
  providerConnections
} from '@bc5000/db';
import type { JobPayloads } from '@bc5000/jobs';

type Provider = JobPayloads['provider.connection-test']['provider'];

export interface ProviderConnectionProbe {
  test(input: {
    organisationId: string;
    provider: Provider;
    secretArn: string;
  }): Promise<{
    healthy: boolean;
    requiredScopes?: string[];
    details?: Record<string, unknown>;
  }>;
}

export interface ProviderConnectionTestDependencies {
  database: Database;
  probe: ProviderConnectionProbe;
  clock: { now(): Date };
}

export async function testProviderConnection(
  dependencies: ProviderConnectionTestDependencies,
  payload: JobPayloads['provider.connection-test']
) {
  const [connection] = await dependencies.database
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organisationId, payload.organisationId),
        eq(providerConnections.provider, payload.provider)
      )
    )
    .limit(1);
  if (!connection) throw new Error('PROVIDER_CONNECTION_NOT_FOUND');

  const result = await dependencies.probe.test({
    organisationId: payload.organisationId,
    provider: payload.provider,
    secretArn: connection.secretArn
  });
  const now = dependencies.clock.now();
  await dependencies.database.transaction(async (transaction) => {
    if (result.healthy) {
      await transaction
        .update(providerConnections)
        .set({
          connectedAt: connection.connectedAt ?? now,
          lastSuccessfulAuthenticationAt: now,
          updatedAt: now
        })
        .where(eq(providerConnections.id, connection.id));
    }
    await transaction.insert(auditEvents).values({
      organisationId: payload.organisationId,
      eventType: 'PROVIDER_CONNECTION_TESTED',
      entityType: 'PROVIDER_CONNECTION',
      entityId: connection.id,
      afterValue: {
        provider: payload.provider,
        healthy: result.healthy,
        requiredScopes: result.requiredScopes ?? [],
        details: result.details ?? null
      },
      occurredAt: now
    });
  });
  return result;
}
