import type { Page } from '@playwright/test';

import { createSessionCookie } from '@bc5000/auth';
import {
  launchScenario,
  seedLaunchScenario,
  seedSmsOptOut as applySmsOptOut
} from '@bc5000/testing';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@127.0.0.1:5432/bc5000';
const sessionSecret = Buffer.alloc(32);

export const resetLaunchScenario = (): Promise<void> =>
  seedLaunchScenario(databaseUrl);

export const seedSmsOptOut = (): Promise<void> => applySmsOptOut(databaseUrl);

export async function loginAs(
  page: Page,
  role: 'ADMIN' | 'OPERATOR'
): Promise<void> {
  const cookie = await createSessionCookie(
    {
      cognitoSubject:
        role === 'ADMIN'
          ? launchScenario.adminSubject
          : launchScenario.operatorSubject
    },
    { secret: sessionSecret }
  );
  const token = decodeURIComponent(
    cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))
  );
  await page.context().addCookies([
    {
      name: 'bc5000_session',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax'
    }
  ]);
}

export { launchScenario };
