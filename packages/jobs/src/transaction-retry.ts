const retryableTransactionCodes = new Set(['40P01', '40001']);

const isRetryableTransactionError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string' &&
  retryableTransactionCodes.has(error.code);

export async function runTransactionWithRetry<Result>(
  operation: () => Promise<Result>,
  maxAttempts = 3
): Promise<Result> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }
    }
  }
  throw new Error('TRANSACTION_RETRY_EXHAUSTED');
}
