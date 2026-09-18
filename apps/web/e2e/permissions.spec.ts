import { expect, test } from '@playwright/test';

import {
  launchScenario,
  loginAs,
  resetLaunchScenario
} from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await resetLaunchScenario();
  await loginAs(page, 'OPERATOR');
});

test('an Operator cannot access administration or enable automatic mode', async ({ page }) => {
  await page.goto(`/sequences/${launchScenario.sequenceId}`);
  await expect(page.getByRole('link', { name: 'Admin Settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Automatic' })).toBeDisabled();

  await page.goto('/settings');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});
