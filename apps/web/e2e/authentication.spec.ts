import { expect, test } from '@playwright/test';

import { loginAs, resetLaunchScenario } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await resetLaunchScenario();
  await loginAs(page, 'ADMIN');
});

test('keeps the session active until the user chooses to sign out', async ({ page }) => {
  const logoutRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/auth/logout') {
      logoutRequests.push(request.url());
    }
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  expect(logoutRequests).toEqual([]);
  await expect(page.getByRole('link', { name: 'Sign out' })).toBeVisible();
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (cookie) => cookie.name === 'bc5000_session'
      )
    )
    .toBe(true);
});
