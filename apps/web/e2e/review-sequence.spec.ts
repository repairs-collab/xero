import { expect, test } from '@playwright/test';

import { loginAs, resetLaunchScenario } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await resetLaunchScenario();
  await loginAs(page, 'OPERATOR');
});

test('reviews and approves the due-date SMS with an audit trail', async ({ page }) => {
  await page.goto('/approvals');

  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  await expect(page.locator('.approval-title').getByText(/INV-5000/)).toBeVisible();
  await page.getByText('Preview exact message').click();
  await expect(page.getByText('Hi Acme Workshop, invoice INV-5000 is due today.')).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();

  await expect(page.getByRole('heading', { name: "You're all caught up" })).toBeVisible();
  await page.goto('/activity?eventType=REMINDER_APPROVED');
  await expect(page.getByText('REMINDER_APPROVED')).toBeVisible();
});
