import { expect, test } from '@playwright/test';

import { fixedVoiceCallCopy } from '@bc5000/domain';

import {
  launchScenario,
  loginAs,
  recordVoicePreviewEvidence,
  readAutomaticVoiceEnabled,
  readVoiceEnabled,
  resetLaunchScenario,
  seedVoiceScenario,
  simulateWrongPersonVoiceOutcome
} from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await resetLaunchScenario('customerLive');
  await seedVoiceScenario();
  await loginAs(page, 'ADMIN');
});

test('keeps setup fictional, locked, and independently disabled until ready', async ({ page }) => {
  await page.goto('/settings/voice');

  await expect(page.getByRole('heading', { name: 'Manual voice calls are off' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Automatic voice reminders are off' })
  ).toBeVisible();
  await expect(page.getByText(fixedVoiceCallCopy.opening)).toBeVisible();
  await expect(page.getByText(fixedVoiceCallCopy.voicemail)).toBeVisible();
  await expect(page.getByText('Wording cannot be edited on this page.')).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(
    page.getByText(
      'No customer will be called. No provider account is required, and AccountPulse makes no speech-provider or telephone request.',
      { exact: true }
    )
  ).toBeVisible();

  await page.getByRole('button', { name: 'Test provider setup' }).click();
  await recordVoicePreviewEvidence();
  await page.reload();
  await expect(page.getByText('Connection ready')).toBeVisible();
  await expect(page.getByText('Generic flow tested')).toBeVisible();

  await page
    .getByLabel('Existing invoice number')
    .fill(launchScenario.invoiceNumber);
  await page
    .getByLabel('Staff-controlled test number')
    .fill('0400 000 002');
  await page.getByRole('button', { name: 'Review test call' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm test call' })
  ).toBeVisible();
  await expect(page.getByText(launchScenario.invoiceNumber, { exact: true })).toBeVisible();
  await expect(page.getByText('+61400000002', { exact: true })).toBeVisible();
  await page.getByLabel(/I confirm this number is controlled by staff/).check();
  await page.getByRole('button', { name: 'Place test voice call' }).click();
  await expect(page.getByText('Test voice call queued.')).toBeVisible();
  await expect(readVoiceEnabled()).resolves.toBe(false);

  await page.getByLabel('Type ENABLE VOICE CALLS to enable').fill('ENABLE VOICE CALLS');
  await page.getByRole('button', { name: 'Enable manual voice calls' }).click();
  await expect(page.getByRole('heading', { name: 'Manual voice calls are on' })).toBeVisible();
  await expect(readVoiceEnabled()).resolves.toBe(true);
  await expect(readAutomaticVoiceEnabled()).resolves.toBe(false);

  await page
    .getByLabel('Type ENABLE AUTOMATIC VOICE CALLS to enable')
    .fill('ENABLE AUTOMATIC VOICE CALLS');
  await page
    .getByRole('button', { name: 'Enable automatic voice reminders' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Automatic voice reminders are on' })
  ).toBeVisible();
  await expect(readAutomaticVoiceEnabled()).resolves.toBe(true);
});

test('reviews one combined call, preserves SMS/email, and surfaces wrong-person suppression', async ({ page }) => {
  await seedVoiceScenario({ enabled: true, ready: true });
  await loginAs(page, 'OPERATOR');
  await page.goto(`/customers/${launchScenario.contactId}`);

  await expect(page.getByRole('button', { name: 'Send SMS' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send email' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Make automated call' }).click();

  const panel = page.getByLabel('Voice reminder review');
  await expect(panel.getByRole('heading', { name: 'Voice reminder review' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Included invoices' })).toBeVisible();
  await expect(panel.getByText(launchScenario.invoiceNumber, { exact: true })).toBeVisible();
  await expect(panel.getByText('INV-FUTURE-1', { exact: true })).toBeVisible();
  await expect(panel.getByText('Not yet overdue')).toBeVisible();
  await expect(panel.getByText(/Press 1 confirms the recipient is authorised/)).toBeVisible();
  await expect(panel.getByText(/Press 2 transfers/)).toBeVisible();
  await expect(panel.locator('textarea')).toHaveCount(0);

  await page.getByLabel(/I confirm these exact account facts/).check();
  await page.getByRole('button', { name: 'Confirm and place call' }).click();
  await expect(page.getByText('Voice call queued')).toBeVisible();

  await simulateWrongPersonVoiceOutcome();
  await page.reload();
  await expect(page.getByText('Wrong person reported')).toBeVisible();
  await expect(page.getByText('Voice reminders suppressed')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review escalation' }).first()).toBeVisible();
});
