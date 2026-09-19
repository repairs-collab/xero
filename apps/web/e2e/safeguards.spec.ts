import { expect, test } from '@playwright/test';

import {
  launchScenario,
  loginAs,
  resetLaunchScenario,
  seedSmsOptOut
} from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await resetLaunchScenario();
  await loginAs(page, 'ADMIN');
});

test('supports per-invoice SMS as an explicitly activated sequence version', async ({ page }) => {
  await page.goto(`/sequences/${launchScenario.sequenceId}`);
  await page.getByLabel('SMS grouping').selectOption('PER_INVOICE');
  await page.getByRole('button', { name: 'Activate new version' }).click();

  await expect(page.getByLabel('SMS grouping')).toHaveValue('PER_INVOICE');
  await expect(page).toHaveURL(/activated=1/);
});

test('records a promise to pay and keeps chasing paused', async ({ page }) => {
  await page.goto(`/customers/${launchScenario.contactId}`);
  const promise = page.locator('details').filter({ hasText: 'Promise to pay' });
  await promise.locator('summary').click();
  await promise.getByLabel('Promised date').fill('2026-10-02');
  await promise.getByLabel('Grace days').fill('3');
  await promise.getByRole('button', { name: 'Record promise' }).click();

  const promiseFlag = page.locator('.account-flags > div', {
    hasText: '2026-10-02'
  });
  await expect(promiseFlag.getByText('Promise to pay', { exact: true })).toBeVisible();
  await expect(promiseFlag.getByText(/2026-10-02.*3 grace days/)).toBeVisible();
  await expect(page.locator('.status-chip', { hasText: 'Chasing paused' })).toBeVisible();
});

test('an SMS opt-out suppresses operator replies', async ({ page }) => {
  await seedSmsOptOut();
  await page.goto(`/inbox/${launchScenario.conversationId}`);

  await expect(page.getByText('SMS replies are disabled')).toBeVisible();
  await expect(page.getByText(/Customer sent STOP/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send reply' })).toHaveCount(0);
});
