import { describe, expect, it, vi } from 'vitest';

import { waitForDatabaseMigrations } from './startup.js';

describe('worker startup', () => {
  it('stays alive until the deployment migration has created the schema', async () => {
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('relation organisations does not exist'))
      .mockRejectedValueOnce(new Error('relation organisations does not exist'))
      .mockResolvedValue(['organisation-1']);
    const wait = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const warn = vi.fn();

    await expect(
      waitForDatabaseMigrations({ load, wait, warn, retryDelayMs: 1 })
    ).resolves.toEqual(['organisation-1']);
    expect(load).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
