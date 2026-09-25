import { describe, expect, it, vi } from 'vitest';

import { runTransactionWithRetry } from './transaction-retry.js';

const postgresError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`PostgreSQL ${code}`), { code });

describe('transaction retry', () => {
  it.each(['40P01', '40001'])(
    'retries PostgreSQL transaction error %s',
    async (code) => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(postgresError(code))
        .mockResolvedValue('completed');

      await expect(runTransactionWithRetry(operation)).resolves.toBe(
        'completed'
      );
      expect(operation).toHaveBeenCalledTimes(2);
    }
  );

  it('does not retry a non-transaction PostgreSQL error', async () => {
    const error = postgresError('23505');
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(runTransactionWithRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops after three retryable failures', async () => {
    const error = postgresError('40P01');
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(runTransactionWithRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
