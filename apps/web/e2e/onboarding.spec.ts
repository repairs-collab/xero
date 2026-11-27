import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createSessionCookie } from '@bc5000/auth';
import {
  createDatabase,
  memberships,
  organisationOnboarding,
  organisations,
  subscriptions,
  users,
  xeroConnections
} from '@bc5000/db';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@127.0.0.1:5432/bc5000';

test('keeps public account creation off by default and offers access by invitation', async ({ page }) => {
  await page.goto('/start');

  await expect(page.getByRole('link', { name: 'Request access' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
});

test('shows evidence-backed setup and customer settings for an invited Solo administrator', async ({
  page
}) => {
  const client = createDatabase(databaseUrl);
  const organisationId = randomUUID();
  const userId = randomUUID();
  const cognitoSubject = randomUUID();
  try {
    await client.db.insert(organisations).values({
      id: organisationId,
      xeroOrganisationId: randomUUID(),
      name: 'Browser Solo',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      edition: 'SOLO',
      operationalState: 'SYNC_REQUIRED'
    });
    await client.db.insert(users).values({
      id: userId,
      cognitoSubject,
      email: `${userId}@example.invalid`,
      displayName: 'Browser Solo Admin'
    });
    await client.db.insert(memberships).values({
      organisationId,
      userId,
      role: 'ADMIN'
    });
    await client.db.insert(subscriptions).values({
      organisationId,
      planCode: 'SOLO_AU_2000',
      status: 'INCOMPLETE',
      trialEndsAt: null
    });
    await client.db.insert(organisationOnboarding).values({
      organisationId,
      version: 1,
      xeroConnectedAt: new Date('2026-10-08T02:00:00.000Z')
    });
    await client.db.insert(xeroConnections).values({
      organisationId,
      connectionId: randomUUID(),
      tenantId: randomUUID(),
      status: 'CONNECTED',
      encryptedRefreshToken: {
        version: 1,
        keyId: 'e2e',
        iv: Buffer.alloc(12).toString('base64'),
        ciphertext: Buffer.from('encrypted').toString('base64'),
        tag: Buffer.alloc(16).toString('base64')
      },
      grantedScopes: ['offline_access', 'accounting.invoices']
    });

    const cookie = await createSessionCookie(
      { cognitoSubject },
      { secret: Buffer.alloc(32) }
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

    await page.goto('/');
    await expect(
      page.getByRole('heading', {
        name: 'Review and accept the AccountPulse terms'
      })
    ).toBeVisible();
    await page.getByRole('checkbox').nth(0).check();
    await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('checkbox').nth(2).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();

    await expect(
      page.getByRole('link', { name: 'Finish setup' })
    ).toBeVisible();
    await page.getByRole('link', { name: 'Finish setup' }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Your Xero organisation is connected'
      })
    ).toBeVisible();
    await expect(page.getByText('1 of 6 complete')).toBeVisible();
    await expect(page.getByText('Setup required')).toBeVisible();
    await expect(page.getByText('Payment is required to activate AccountPulse')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Complete a test SMS' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send verification code' })).toHaveCount(0);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Customer sending' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Test sending' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'VoIPcloud voice' })).toHaveCount(0);

    await page.goto('/settings/test-sms');
    await expect(page).toHaveURL(/\/settings$/);
    await page.goto('/settings/voice');
    await expect(page).toHaveURL(/\/settings$/);
    await page.goto('/settings/sending');
    await expect(page.getByRole('heading', { name: 'Customer sending is off' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable customer sending' })).toHaveCount(0);
    await expect(page.getByLabel('Mobile numbers or email addresses')).toHaveCount(0);
  } finally {
    await client.pool.end();
  }
});
