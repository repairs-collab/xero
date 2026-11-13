import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Xero invoice refresh production wiring', () => {
  it('captures the connection generation before resolving the Xero client', async () => {
    const source = await readFile(new URL('./entrypoint.ts', import.meta.url), 'utf8');
    const start = source.indexOf('[jobNames.xeroInvoiceRefresh]');
    const end = source.indexOf('[jobNames.xeroNightlyReconcile]', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);

    expect(handler).toContain(
      'loadXero: () => xeroFactory.forOrganisation(payload.organisationId)'
    );
    expect(handler).not.toContain(
      'xero: await xeroFactory.forOrganisation(payload.organisationId)'
    );
  });
});
