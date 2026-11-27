import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../connection.js';
import {
  platformAdminAuditEvents,
  users,
  workerRepairRequests,
  workerRepairRunner,
  type WorkerRepairHealth,
  type WorkerRepairResult,
  type WorkerRepairStatus
} from '../schema/index.js';

export const workerRepairCooldownMs = 10 * 60_000;

export type WorkerRepairRequestResult =
  | 'REQUESTED'
  | 'ALREADY_REQUESTED'
  | 'COOLDOWN'
  | 'NOT_OWNER'
  | 'INVALID_REQUEST'
  | 'RUNNER_UNAVAILABLE';

export interface WorkerRepairRequestView {
  status: WorkerRepairStatus;
  resultCode: WorkerRepairResult | null;
  beforeHealth: WorkerRepairHealth | null;
  afterHealth: WorkerRepairHealth | null;
  requestedAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
}

const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const recentRunner = sql`${workerRepairRunner.lastSeenAt} > now() - interval '2 minutes'`;

export async function loadWorkerRepairRunnerAvailable(
  database: Pick<Database, 'select'>
): Promise<boolean> {
  const [runner] = await database.select({ id: workerRepairRunner.id })
    .from(workerRepairRunner).where(recentRunner);
  return runner !== undefined;
}

export async function loadLatestWorkerRepair(database: Database): Promise<WorkerRepairRequestView | null> {
  const [latest] = await database.select({
    status: workerRepairRequests.status,
    resultCode: workerRepairRequests.resultCode,
    beforeHealth: workerRepairRequests.beforeHealth,
    afterHealth: workerRepairRequests.afterHealth,
    requestedAt: workerRepairRequests.requestedAt,
    claimedAt: workerRepairRequests.claimedAt,
    completedAt: workerRepairRequests.completedAt,
    expired: sql<boolean>`
      case
        when ${workerRepairRequests.status} = 'PENDING' then ${workerRepairRequests.expiresAt} <= now()
        when ${workerRepairRequests.status} = 'RUNNING' then ${workerRepairRequests.claimExpiresAt} <= now()
        else false
      end
    `
  }).from(workerRepairRequests).orderBy(desc(workerRepairRequests.requestedAt), desc(workerRepairRequests.id)).limit(1);
  if (!latest) return null;
  const { expired, ...view } = latest;
  if (!expired) return view;
  return {
    ...view,
    status: 'EXPIRED',
    resultCode: view.status === 'PENDING' ? 'EXPIRED_BEFORE_START' : 'EXPIRED_AFTER_CLAIM'
  };
}

export async function requestWorkerRepair(
  database: Database,
  actorUserId: string,
  requestId: string
): Promise<WorkerRepairRequestResult> {
  if (!requestIdPattern.test(requestId)) return 'INVALID_REQUEST';

  return database.transaction(async (transaction) => {
    // Keep this key consistent with the protected OVH repair runner.
    await transaction.execute(sql`select pg_advisory_xact_lock(9041780001)`);
    const [owner] = await transaction.select({ id: users.id }).from(users)
      .where(and(eq(users.id, actorUserId), eq(users.platformRole, 'OWNER'), isNull(users.disabledAt)))
      .for('update');
    if (!owner) return 'NOT_OWNER';

    const [existing] = await transaction.select({ id: workerRepairRequests.id })
      .from(workerRepairRequests).where(eq(workerRepairRequests.id, requestId));
    if (existing) return 'ALREADY_REQUESTED';
    if (!await loadWorkerRepairRunnerAvailable(transaction)) return 'RUNNER_UNAVAILABLE';

    const [active] = await transaction.select({ id: workerRepairRequests.id }).from(workerRepairRequests)
      .where(inArray(workerRepairRequests.status, ['PENDING', 'RUNNING']));
    if (active) return 'ALREADY_REQUESTED';
    const [recent] = await transaction.select({ id: workerRepairRequests.id }).from(workerRepairRequests)
      .where(sql`${workerRepairRequests.requestedAt} > now() - ${workerRepairCooldownMs}::bigint * interval '1 millisecond'`)
      .limit(1);
    if (recent) return 'COOLDOWN';

    await transaction.insert(workerRepairRequests).values({ id: requestId, requestedByUserId: owner.id });
    await transaction.insert(platformAdminAuditEvents).values({
      actorUserId: owner.id,
      eventType: 'WORKER_REPAIR_REQUESTED',
      entityType: 'WORKER_REPAIR',
      entityId: requestId,
      reason: 'Owner requested an AccountPulse worker health check and bounded restart'
    });
    return 'REQUESTED';
  });
}
