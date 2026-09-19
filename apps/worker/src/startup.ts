interface DatabaseMigrationWaitOptions<T> {
  load: () => Promise<T>;
  wait?: (milliseconds: number) => Promise<void>;
  warn?: (message: string, details: { reason: string }) => void;
  retryDelayMs?: number;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForDatabaseMigrations<T>(
  options: DatabaseMigrationWaitOptions<T>
): Promise<T> {
  const pause = options.wait ?? wait;
  const warn = options.warn ?? console.warn;
  const retryDelayMs = options.retryDelayMs ?? 5_000;

  for (;;) {
    try {
      return await options.load();
    } catch (error) {
      warn('Waiting for the deployment migration to prepare the database', {
        reason: error instanceof Error ? error.message : 'Unknown database error'
      });
      await pause(retryDelayMs);
    }
  }
}
