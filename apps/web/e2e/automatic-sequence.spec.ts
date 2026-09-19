import { expect, test } from '@playwright/test';

import {
  launchScenario,
  loginAs,
  resetLaunchScenario
} from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await resetLaunchScenario();
  await loginAs(page, 'ADMIN');
});

test('an administrator switches one sequence to automatic with the 7-day email and SMS stage', async ({ page }) => {
  await page.goto(`/sequences/${launchScenario.sequenceId}`);

  const sevenDayStage = page.locator('.stage-card', {
    has: page.locator('input[value="seven-days"]')
  });
  await expect(sevenDayStage.getByLabel('SMS', { exact: true })).toBeChecked();
  await expect(sevenDayStage.getByLabel('Xero email')).toBeChecked();
  await expect(page.getByLabel('SMS grouping')).toHaveValue('CONSOLIDATED_CUSTOMER');
  await page.getByRole('button', { name: 'Automatic' }).click();

  await expect(page.getByRole('heading', { name: 'Automatic' })).toBeVisible();
  await page.goto('/activity?eventType=SEQUENCE_MODE_CHANGED');
  await expect(page.getByText('SEQUENCE_MODE_CHANGED')).toBeVisible();
});

test('dry-run and allowlist gates are visible before live sending', async ({ page }) => {
  await page.goto('/settings/sending');
  await expect(page.getByRole('heading', { name: 'Dry-run only' })).toBeVisible();
  await expect(page.getByLabel('Mobile numbers')).toHaveValue('+61400000001');
  await expect(page.getByText('Controlled end-to-end test passed')).toHaveClass(/passed/);
});
