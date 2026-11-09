import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { xeroConnections } from './xero.js';

describe('Xero connection schema contract', () => {
  it('persists the provider connection id needed for tenant-specific revocation', () => {
    const config = getTableConfig(xeroConnections);

    expect(config.columns.map((column) => column.name)).toContain('connection_id');
    expect(config.indexes.map((index) => index.config.name)).toContain(
      'xero_connections_connection_uq'
    );
  });
});
