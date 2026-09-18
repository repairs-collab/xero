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

test('a reply pauses all chasing and a dispute remains visible on the account', async ({ page }) => {
  await page.goto(`/inbox/${launchScenario.conversationId}`);
  await expect(page.getByText('Can we pay Friday?')).toBeVisible();
  await expect(page.getByText('Paused after reply')).toBeVisible();

  await page.goto(`/customers/${launchScenario.contactId}`);
  await expect(page.locator('.status-chip', { hasText: 'Chasing paused' })).toBeVisible();
  const dispute = page.locator('details').filter({ hasText: 'Record dispute' });
  await dispute.locator('summary').click();
  await dispute.getByLabel('Invoice').selectOption(launchScenario.invoiceId);
  await dispute.getByLabel('Reason').fill('Purchase order amount is disputed');
  await dispute.getByRole('button', { name: 'Record and pause' }).click();

  const openDispute = page.locator('.account-flags > div', {
    hasText: 'Open dispute'
  });
  await expect(openDispute.getByText('Open dispute')).toBeVisible();
  await expect(openDispute.getByText('Purchase order amount is disputed')).toBeVisible();
  await expect(page.locator('.status-chip', { hasText: 'Chasing paused' })).toBeVisible();
});
