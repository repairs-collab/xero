import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('initializes Stripe from a standalone worker bundle without node_modules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'accountpulse-stripe-runtime-'));
  const bundle = join(directory, 'worker-stripe.mjs');
  try {
    await build({
      stdin: {
        contents: `
          import { createStripeBillingClient } from './packages/integrations/src/stripe/client.ts';
          const client = createStripeBillingClient({
            secretKey: 'sk_test_runtime_smoke',
            webhookSecret: 'whsec_runtime_smoke',
            soloMonthlyPriceId: 'price_monthly',
            soloAnnualPriceId: 'price_annual',
            soloSmsOveragePriceId: 'price_overage',
            portalConfigurationId: 'bpc_runtime_smoke',
            publicBaseUrl: 'https://accountpulse.example.test',
            priceCurrency: 'aud',
            automaticTaxEnabled: true,
            webhookToleranceSeconds: 300
          });
          console.log(JSON.stringify(client.checkoutConfiguration('MONTHLY')));
        `,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: bundle,
      banner: {
        js: "import { createRequire as accountPulseCreateRequire } from 'node:module'; const require = accountPulseCreateRequire(import.meta.url);"
      }
    });
    const result = spawnSync(process.execPath, [bundle], {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '' },
      encoding: 'utf8',
      timeout: 10_000
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      priceId: 'price_monthly',
      automaticTaxEnabled: true,
      publicOrigin: 'https://accountpulse.example.test'
    });
  } finally {
    if (dirname(resolve(directory)) === resolve(tmpdir())) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 20_000);
