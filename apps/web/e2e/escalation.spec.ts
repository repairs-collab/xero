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

test('the 30-day escalation task coexists with daily SMS and can be completed separately', async ({ page }) => {
  await page.goto(`/sequences/${launchScenario.sequenceId}`);
  await page.getByLabel('Day counting').selectOption('CALENDAR_DAYS');
  await page.getByRole('button', { name: 'Activate new version' }).click();

  await page.goto('/escalations');
  await expect(page.getByText('Manual escalation required after 30 days overdue')).toBeVisible();
  await expect(page.getByText(/Active.*Calendar days/)).toBeVisible();
  await page.getByLabel('Resolution note').fill('Account manager called the customer');
  await page.getByRole('button', { name: 'Complete task' }).click();

  await expect(page.getByRole('heading', { name: 'No open escalations' })).toBeVisible();
});
