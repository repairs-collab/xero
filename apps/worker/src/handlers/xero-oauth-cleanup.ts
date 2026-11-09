import { inArray, isNotNull, lte, or } from 'drizzle-orm';

import {
  type Database,
  xeroOAuthTransactions,
  xeroPendingAuthorisations
} from '@bc5000/db';

export const cleanupExpiredXeroOAuthState = async (dependencies: {
  database: Database;
  clock: { now(): Date };
  batchSize?: number;
}): Promise<{ transactionsDeleted: number; pendingAuthorisationsDeleted: number }> => {
  const now = dependencies.clock.now();
  const batchSize = dependencies.batchSize ?? 500;

  const transactionRows = await dependencies.database
    .select({ id: xeroOAuthTransactions.id })
    .from(xeroOAuthTransactions)
    .where(
      or(
        lte(xeroOAuthTransactions.expiresAt, now),
        isNotNull(xeroOAuthTransactions.consumedAt)
      )
    )
    .limit(batchSize);
  const transactionsDeleted =
    transactionRows.length === 0
      ? 0
      : (
          await dependencies.database
            .delete(xeroOAuthTransactions)
            .where(
              inArray(
                xeroOAuthTransactions.id,
                transactionRows.map((row) => row.id)
              )
            )
            .returning({ id: xeroOAuthTransactions.id })
        ).length;

  const pendingRows = await dependencies.database
    .select({ id: xeroPendingAuthorisations.id })
    .from(xeroPendingAuthorisations)
    .where(
      or(
        lte(xeroPendingAuthorisations.expiresAt, now),
        isNotNull(xeroPendingAuthorisations.consumedAt)
      )
    )
    .limit(batchSize);
  const pendingAuthorisationsDeleted =
    pendingRows.length === 0
      ? 0
      : (
          await dependencies.database
            .delete(xeroPendingAuthorisations)
            .where(
              inArray(
                xeroPendingAuthorisations.id,
                pendingRows.map((row) => row.id)
              )
            )
            .returning({ id: xeroPendingAuthorisations.id })
        ).length;

  return { transactionsDeleted, pendingAuthorisationsDeleted };
};
