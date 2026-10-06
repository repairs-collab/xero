import { expect, test } from '@playwright/test';

import {
  bumpOperationalStateVersion,
  launchScenario,
  loginAs,
  prepareCustomerRolloutScenario,
  readRolloutState,
  resetLaunchScenario,
  seedSmsOptOut
} from './fixtures.js';

const reconciliationAcknowledgement =
  'I confirm these figures match the current Xero receivables for this sync';
const customerAcknowledgement =
  'I understand approved reminders may be sent to customers';

test.beforeEach(async ({ page }) => {
  await resetLaunchScenario();
  await loginAs(page, 'ADMIN');
});

test('shows the final rollout safeguards without an in-app reset control', async ({ page }) => {
  await page.goto('/settings/sending');

  await expect(page.getByRole('heading', { name: 'Dry run' })).toBeVisible();
  await expect(page.getByText('Controlled live', { exact: true })).toBeVisible();
  await expect(page.getByText('Customer live', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Technical recipient allowlist', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Fresh Xero sync required', { exact: true })
  ).toBeVisible();
  await expect(page.getByText(/test xero email/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /reset/i })).toHaveCount(0);
});

test('shows failed gates in controlled live before final approval is available', async ({
  page
}) => {
  await resetLaunchScenario('controlledLive');
  await page.goto('/settings/sending');

  await expect(page.getByRole('heading', { name: 'Controlled live' })).toBeVisible();
  await expect(page.getByText('Action required')).toBeVisible();
  await expect(page.getByText('Controlled Test SMS')).toBeVisible();
  await expect(
    page.getByText(/Send a Test SMS to a number on the technical allowlist/)
  ).toBeVisible();
  await expect(
    page.getByLabel('Type the exact customer-rollout acknowledgement')
  ).toHaveCount(0);
});

test('keeps the technical allowlist after reset and requires fresh sync and Test SMS evidence', async ({
  page
}) => {
  await resetLaunchScenario('resetSyncRequired');
  await page.goto('/settings/sending');

  await expect(page.getByRole('heading', { name: 'Controlled live' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reset complete' })).toBeVisible();
  await expect(page.getByText('Fresh Xero sync required', { exact: true })).toBeVisible();
  await expect(page.getByText('No successful sync recorded')).toBeVisible();
  await expect(page.getByText('Complete the fresh Xero sync before reconciling the figures.')).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: '0' })).toHaveCount(3);
  await expect(page.getByLabel('Mobile numbers or email addresses')).toHaveValue(
    launchScenario.mobile
  );
  await expect(page.getByText('Controlled Test SMS')).toBeVisible();
  await expect(
    page.getByText(/Send a Test SMS to a number on the technical allowlist/)
  ).toBeVisible();
});

test('rejects an inexact final customer acknowledgement', async ({ page }) => {
  await resetLaunchScenario('reconciledReady');
  await page.goto('/settings/sending');

  await page
    .getByLabel('Type the exact customer-rollout acknowledgement')
    .fill('I approve customer reminders');
  await page
    .getByRole('button', { name: 'Enable Customer live', exact: true })
    .click();

  await expect(page).toHaveURL(
    /rollout=CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT_MISMATCH/
  );
  await expect(
    page.getByText('Customer-rollout acknowledgement did not match')
  ).toBeVisible();
  await expect(readRolloutState()).resolves.toMatchObject({
    sendMode: 'live',
    rolloutScope: 'CONTROLLED',
    operationalState: 'RECONCILED'
  });
});

test('reconciles, activates customers, rolls back, and performs an emergency stop', async ({
  page
}) => {
  await prepareCustomerRolloutScenario();
  await page.goto('/settings/sending');

  await expect(page.getByRole('heading', { name: 'Controlled live' })).toBeVisible();
  const reconciliation = page.getByLabel(
    'Type the exact reconciliation acknowledgement'
  );
  await expect(reconciliation).toHaveAttribute(
    'placeholder',
    reconciliationAcknowledgement
  );
  await reconciliation.fill(reconciliationAcknowledgement);
  await page.getByRole('button', { name: 'Record reconciliation' }).click();

  await expect(page).toHaveURL(/rollout=reconciled/);
  await expect(page.getByText('Current Xero figures reconciled')).toBeVisible();
  const finalApproval = page.getByLabel(
    'Type the exact customer-rollout acknowledgement'
  );
  await expect(finalApproval).toHaveAttribute(
    'placeholder',
    customerAcknowledgement
  );
  await finalApproval.fill(customerAcknowledgement);
  await page
    .getByRole('button', { name: 'Enable Customer live', exact: true })
    .click();

  await expect(page).toHaveURL(/rollout=customer-enabled/);
  await expect(page.getByRole('heading', { name: 'Customer live' })).toBeVisible();
  await expect(readRolloutState()).resolves.toMatchObject({
    sendMode: 'live',
    rolloutScope: 'CUSTOMER',
    operationalState: 'RECONCILED'
  });
  await expect(page.getByLabel('Mobile numbers or email addresses')).toHaveValue(
    launchScenario.mobile
  );

  await page
    .getByLabel('Reason for returning to Controlled live')
    .fill('Pause customer delivery for an operational check');
  await page.getByRole('button', { name: 'Return to Controlled live' }).click();
  await expect(page).toHaveURL(/rollout=controlled-restored/);
  await expect(page.getByRole('heading', { name: 'Controlled live' })).toBeVisible();

  await page
    .getByLabel('Type the exact customer-rollout acknowledgement')
    .fill(customerAcknowledgement);
  await page
    .getByRole('button', { name: 'Enable Customer live', exact: true })
    .click();
  await expect(page).toHaveURL(/rollout=customer-enabled/);

  await page
    .getByLabel('Reason for disabling all provider sending')
    .fill('Emergency stop browser proof');
  await page
    .getByRole('button', { name: 'Disable all provider sending' })
    .click();
  await expect(page).toHaveURL(/rollout=provider-sending-disabled/);
  await expect(page.getByRole('heading', { name: 'Dry run' })).toBeVisible();
  await expect(readRolloutState()).resolves.toMatchObject({
    sendMode: 'dry-run',
    rolloutScope: 'CONTROLLED'
  });
});

test('rejects a stale reconciliation form without changing rollout state', async ({
  page
}) => {
  await prepareCustomerRolloutScenario();
  await page.goto('/settings/sending');
  await bumpOperationalStateVersion();

  await page
    .getByLabel('Type the exact reconciliation acknowledgement')
    .fill(reconciliationAcknowledgement);
  await page.getByRole('button', { name: 'Record reconciliation' }).click();

  await expect(page).toHaveURL(/rollout=OPERATIONAL_STATE_CONFLICT/);
  await expect(page.getByText('This page is out of date')).toBeVisible();
  await expect(readRolloutState()).resolves.toMatchObject({
    sendMode: 'live',
    rolloutScope: 'CONTROLLED',
    operationalState: 'RECONCILIATION_REQUIRED'
  });
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
