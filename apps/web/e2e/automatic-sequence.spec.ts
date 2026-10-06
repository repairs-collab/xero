import { expect, test } from '@playwright/test';

import {
  launchScenario,
  loginAs,
  resetLaunchScenario
} from './fixtures.js';

const customerAcknowledgement =
  'I understand approved reminders may be sent to customers';

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

test('dry-run and controlled-launch gates are visible before live testing', async ({ page }) => {
  await page.goto('/settings/sending');
  await expect(page.getByRole('heading', { name: 'Dry run' })).toBeVisible();
  await expect(page.getByLabel('Mobile numbers or email addresses')).toHaveValue('+61400000001');
  await expect(page.getByRole('heading', { name: 'Final sending readiness' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable Controlled live' })).toBeVisible();
  await expect(page.getByText(/Provider calls are disabled/)).toBeVisible();
});

test('customer rollout keeps the first reminder cohort in Review mode', async ({
  page
}) => {
  await resetLaunchScenario('reconciledReady');
  await page.goto('/settings/sending');
  await page
    .getByLabel('Type the exact customer-rollout acknowledgement')
    .fill(customerAcknowledgement);
  await page
    .getByRole('button', { name: 'Enable Customer live', exact: true })
    .click();
  await expect(page).toHaveURL(/rollout=customer-enabled/);

  await page.goto(`/sequences/${launchScenario.sequenceId}`);
  await expect(page.getByRole('heading', { name: 'Review and approve' })).toBeVisible();
  await page.goto('/approvals');
  await expect(page.locator('.approval-title').getByText(/INV-5000/)).toBeVisible();
});
