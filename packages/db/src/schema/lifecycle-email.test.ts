import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';
import * as schema from './index.js';

it('registers a separate lifecycle outbox and an additive migration preserving held billing evidence', async () => {
  expect(schema.lifecycleEmailOutbox).toBeDefined();
  expect(getTableConfig(schema.lifecycleEmailOutbox).name).toBe('lifecycle_email_outbox');
  const folder = new URL('../../drizzle/', import.meta.url);
  const tag = '0049_lifecycle_email_outbox';
  const contents = await readFile(new URL(`${tag}.sql`, folder), 'utf8');
  expect(contents).toContain('CREATE TABLE lifecycle_email_outbox');
  expect(contents).not.toMatch(/transactional_email_outbox/i);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', folder), 'utf8')) as { entries: unknown[] };
  expect(journal.entries).toContainEqual(expect.objectContaining({ idx: 49, tag }));
});

it('adds dedicated owner-monitoring indexes without changing the lifecycle outbox migration', async () => {
  const config = getTableConfig(schema.lifecycleEmailOutbox);
  expect(config.indexes.map((value) => value.config.name)).toEqual(
    expect.arrayContaining([
      'lifecycle_email_updated_idx',
      'lifecycle_email_status_updated_idx'
    ])
  );
  const contents = await readFile(
    new URL('../../drizzle/0051_lifecycle_email_monitoring_indexes.sql', import.meta.url),
    'utf8'
  );
  expect(contents).toContain('lifecycle_email_updated_idx');
  expect(contents).toContain('lifecycle_email_status_updated_idx');
  expect(contents).not.toMatch(/recipient|render_data|idempotency_key|message_id|provider_message_id/i);
});
