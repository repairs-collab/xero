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
});

test('lets a membership-free owner administer the beta customer without exposing secrets', async ({ page }) => {
  await loginAsPlatformOwner(page);
  await page.goto('/platform-admin');
  await expect(page.getByRole('heading', { name: 'Customer overview' })).toBeVisible();
  await expect(page.getByText(platformOwnerScenario.customerName)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('secretArn');
  await expect(page.locator('body')).not.toContainText('ciphertext');

  await page.getByText(platformOwnerScenario.customerName).click();
  await expect(page.getByText('xero-tenant-platform-beta')).toBeVisible();

  const trial = page.locator('form').filter({ has: page.getByRole('button', { name: 'Extend trial' }) });
  await trial.getByLabel('New trial end').fill('2026-11-30T00:00');
  await trial.getByLabel('Reason').fill('Approved beta extension');
  await trial.getByRole('checkbox').check();
  await trial.getByRole('button', { name: 'Extend trial' }).click();
  await expect(page.getByText(/30 Nov 2026/)).toBeVisible();

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
  await expect(page.getByText('Approved beta extension')).toBeVisible();
  await expect(page.getByText('Temporary billing review')).toBeVisible();
});

test('registers, assigns and verifies a Sinch number', async ({ page }) => {
  await loginAsPlatformOwner(page);
  await page.goto('/platform-admin/sms');

  const registration = page.locator('form').filter({ has: page.getByRole('button', { name: 'Register number' }) });
  await registration.getByLabel('Number').fill('+61400000999');
  await registration.getByLabel('Reason').fill('Beta number purchase');
  await registration.getByRole('button', { name: 'Register number' }).click();

  const number = page.locator('article').filter({ hasText: '+61400000999' });
  await expect(number).toBeVisible();
  await number.getByLabel('Customer for +61400000999').selectOption(launchScenario.organisationId);
  await number.getByPlaceholder('Reason').fill('Assign beta customer');
  await number.getByRole('button', { name: 'Assign customer' }).click();

  const reserved = page.locator('article').filter({ hasText: '+61400000999' });
  await expect(reserved.getByPlaceholder('Verified Sinch provider ID')).toBeVisible();
  await reserved.getByPlaceholder('Verified Sinch provider ID').fill('sinch-beta-999');
  await reserved.getByPlaceholder('Verification reason').fill('Verified in Sinch APAC');
  await reserved.getByRole('button', { name: 'Mark ready' }).click();
  await expect(page.locator('article').filter({ hasText: '+61400000999' })).toContainText('Ready');
});
