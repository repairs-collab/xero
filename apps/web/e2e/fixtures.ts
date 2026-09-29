import type { Page } from '@playwright/test';
import { eq, sql } from 'drizzle-orm';

import { createSessionCookie } from '@bc5000/auth';
import {
  createDatabase,
  organisations,
  outboundMessages,
  providerConnections
} from '@bc5000/db';
import {
  launchScenario,
  seedLaunchScenario,
  seedSmsOptOut as applySmsOptOut
} from '@bc5000/testing';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@127.0.0.1:5432/bc5000';
const sessionSecret = Buffer.alloc(32);

export const resetLaunchScenario = (): Promise<void> =>
  seedLaunchScenario(databaseUrl);

export const seedSmsOptOut = (): Promise<void> => applySmsOptOut(databaseUrl);

export async function prepareCustomerRolloutScenario(): Promise<void> {
  const client = createDatabase(databaseUrl);
  const now = new Date();
  try {
    await client.db
      .update(organisations)
      .set({
        sendMode: 'live',
        rolloutScope: 'CONTROLLED',
        liveSendAcknowledged: true,
        operationalState: 'RECONCILIATION_REQUIRED',
        operationalStateVersion: 3,
        lastSuccessfulSyncAt: now,
        latestReconciledSyncAt: null,
        updatedAt: now
      })
      .where(eq(organisations.id, launchScenario.organisationId));
    await client.db
      .update(providerConnections)
      .set({
        connectedAt: now,
        lastSuccessfulAuthenticationAt: now,
        updatedAt: now
      })
      .where(eq(providerConnections.organisationId, launchScenario.organisationId));
    await client.db.insert(outboundMessages).values({
      organisationId: launchScenario.organisationId,
      actorUserId: launchScenario.adminUserId,
      channel: 'SMS',
      source: 'TEST_SMS',
      recipientKey: launchScenario.mobile,
      status: 'DELIVERED',
      idempotencyKey: `rollout-e2e-${now.getTime()}`,
      completedAt: now,
      createdAt: now,
      updatedAt: now
    });
  } finally {
    await client.pool.end();
  }
}

export async function bumpOperationalStateVersion(): Promise<void> {
  const client = createDatabase(databaseUrl);
  try {
    await client.db
      .update(organisations)
      .set({
        operationalStateVersion: sql`${organisations.operationalStateVersion} + 1`
      })
      .where(eq(organisations.id, launchScenario.organisationId));
  } finally {
    await client.pool.end();
  }
}

export async function readRolloutState(): Promise<{
  sendMode: 'dry-run' | 'live';
  rolloutScope: 'CONTROLLED' | 'CUSTOMER';
  operationalState: string;
}> {
  const client = createDatabase(databaseUrl);
  try {
    const [organisation] = await client.db
      .select({
        sendMode: organisations.sendMode,
        rolloutScope: organisations.rolloutScope,
        operationalState: organisations.operationalState
      })
      .from(organisations)
      .where(eq(organisations.id, launchScenario.organisationId))
      .limit(1);
    if (!organisation) throw new Error('E2E organisation not found');
    return organisation;
  } finally {
    await client.pool.end();
  }
}

export async function loginAs(
  page: Page,
  role: 'ADMIN' | 'OPERATOR'
): Promise<void> {
  const cookie = await createSessionCookie(
    {
      cognitoSubject:
        role === 'ADMIN'
          ? launchScenario.adminSubject
          : launchScenario.operatorSubject
    },
    { secret: sessionSecret }
  );
  const token = decodeURIComponent(
    cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))
  );
  await page.context().addCookies([
    {
      name: 'bc5000_session',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax'
    }
  ]);
}

export { launchScenario };
