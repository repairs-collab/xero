import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  auditEvents,
  createDatabase,
  migrateDatabase,
  organisations,
  providerConnections
} from '@bc5000/db';

import { testProviderConnection } from '../src/handlers/provider-connection-test.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-09-18T02:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

describe('provider connection worker', () => {
  it('tests a secret reference in the worker and records healthy Xero scopes', async () => {
    const organisationId = randomUUID();
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Provider test',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD'
    });
    await client.db.insert(providerConnections).values({
      organisationId,
      provider: 'XERO',
      secretArn:
        'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:xero'
    });
    const probe = vi.fn(() =>
      Promise.resolve({
        healthy: true,
        requiredScopes: [
          'accounting.invoices',
          'accounting.contacts.read',
          'accounting.settings.read'
        ]
      })
    );

    await testProviderConnection(
      { database: client.db, probe: { test: probe }, clock: { now: () => now } },
      { organisationId, provider: 'XERO' }
    );

    expect(probe).toHaveBeenCalledWith({
      organisationId,
      provider: 'XERO',
      secretArn:
        'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:xero'
    });
    const [connection] = await client.db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.organisationId, organisationId),
          eq(providerConnections.provider, 'XERO')
        )
      );
    expect(connection).toMatchObject({
      connectedAt: now,
      lastSuccessfulAuthenticationAt: now
    });
    const [event] = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organisationId, organisationId));
    expect(event?.afterValue).toMatchObject({ healthy: true, provider: 'XERO' });
    expect(JSON.stringify(event)).not.toContain('secret:xero');
  });
});
