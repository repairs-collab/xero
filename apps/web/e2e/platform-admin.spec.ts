import { expect, test } from '@playwright/test';

import {
  launchScenario,
  loginAs,
  loginAsPlatformOwner,
  platformOwnerScenario,
  seedPlatformAdminScenario
} from './fixtures.js';

test.beforeEach(async () => {
  await seedPlatformAdminScenario();
});

test('denies an ordinary customer administrator', async ({ page }) => {
  await loginAs(page, 'ADMIN');
  await page.goto('/platform-admin');
  await expect(page.getByRole('heading', { name: 'This page could not be found.' })).toBeVisible();

  const backup = await page.request.get(
    `/platform-admin/organisations/${launchScenario.organisationId}/backup`
  );
  expect(backup.status()).toBe(404);
  expect(await backup.text()).not.toContain(platformOwnerScenario.customerName);
});

test('lets a membership-free owner administer the paid beta customer without exposing secrets', async ({ page }) => {
  test.setTimeout(60_000);
  await loginAsPlatformOwner(page);
  await page.goto('/platform-admin');
  await expect(page.getByRole('heading', { name: 'Customer overview' })).toBeVisible();
  await expect(page.getByText(platformOwnerScenario.customerName)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('secretArn');
  await expect(page.locator('body')).not.toContainText('ciphertext');

  await page.goto(
    `/platform-admin/organisations/${launchScenario.organisationId}`
  );
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: platformOwnerScenario.customerName
    })
  ).toBeVisible();
  await expect(
    page.locator('.platform-fact-grid').getByText('xero-tenant-platform-beta')
  ).toBeVisible();

  const subscription = page.locator('.platform-fact-grid article').filter({
    has: page.getByText('Subscription', { exact: true })
  });
  await expect(subscription.getByText('ACTIVE', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Extend trial' })).toHaveCount(0);

  const allowance = page.locator('form').filter({ has: page.getByRole('button', { name: 'Update allowance' }) });
  await allowance.getByLabel('Included SMS parts').fill('2500');
  await allowance.getByLabel('Warning percent').fill('85');
  await allowance.getByLabel('Reason').fill('Beta allowance agreed');
  await allowance.getByRole('checkbox').check();
  await allowance.getByRole('button', { name: 'Update allowance' }).click();
  await expect(page.getByText(/of 2,500 parts/)).toBeVisible();

  const suspend = page.locator('form').filter({ has: page.getByRole('button', { name: 'Suspend account' }) });
  await suspend.getByLabel('Reason').fill('Temporary billing review');
  await suspend.getByRole('checkbox').check();
  await suspend.getByRole('button', { name: 'Suspend account' }).click();
  await expect(page.getByText('SUSPENDED', { exact: true })).toBeVisible();

  await page.goto('/platform-admin/audit');
  await expect(page.getByText('Temporary billing review')).toBeVisible();
});

test('registers an existing Sinch number, assigns it and verifies readiness', async ({ page }) => {
  await loginAsPlatformOwner(page);
  await page.goto('/platform-admin/sms');

  const legacyPool = page.locator('details').filter({
    has: page.getByText('Legacy spare-number pool', { exact: true })
  });
  await legacyPool.locator('summary').click();
  const registration = legacyPool.locator('form').filter({
    has: page.getByRole('button', { name: 'Register existing number' })
  });
  await registration.getByLabel('Number').fill('+61400000999');
  await registration.getByLabel('Sinch provider ID').fill('sinch-beta-999');
  await registration.getByLabel('Reason').fill('Beta number purchase');
  await registration.getByRole('button', { name: 'Register existing number' }).click();
  await expect(page.getByRole('status')).toContainText('Change saved');

  await legacyPool.locator('summary').click();

  const number = legacyPool.locator('article').filter({ hasText: '+61400000999' });
  await expect(number).toBeVisible();
  const assignment = number.locator('form').filter({
    has: page.getByRole('button', { name: 'Assign customer' })
  });
  await assignment.getByLabel('Customer for +61400000999').selectOption(launchScenario.organisationId);
  await assignment.getByPlaceholder('Reason', { exact: true }).fill('Assign beta customer');
  await assignment.getByRole('button', { name: 'Assign customer' }).click();

  const reserved = page.locator('article').filter({ hasText: '+61400000999' });
  await expect(reserved.getByPlaceholder('Verified Sinch provider ID')).toBeVisible();
  await reserved.getByPlaceholder('Verified Sinch provider ID').fill('sinch-beta-999');
  await reserved.getByPlaceholder('Verification reason').fill('Verified in Sinch APAC');
  await reserved.getByRole('button', { name: 'Mark ready' }).click();
  await expect(page.locator('article').filter({ hasText: '+61400000999' })).toContainText('Ready');
});
