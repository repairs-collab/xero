import { AuthorizationFailure } from '@bc5000/auth';
import {
  PostgresLifecycleEmailMonitoringRepository,
  type LifecycleEmailMonitoringRepository
} from '@bc5000/db/web';

import { isPlatformOwner } from './platform-authorization.js';
import { getDatabaseClient } from './runtime.js';

export interface PlatformEmailMonitoringDependencies {
  verifyOwner(userId: string): Promise<boolean>;
  repository: LifecycleEmailMonitoringRepository;
  clock: { now(): Date };
}

export const createPlatformEmailMonitoringService = (
  dependencies: PlatformEmailMonitoringDependencies
) => ({
  async getSnapshot(actorUserId: string) {
    if (!(await dependencies.verifyOwner(actorUserId))) {
      throw new AuthorizationFailure();
    }
    const now = dependencies.clock.now();
    return dependencies.repository.readSnapshot({
      now,
      since: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      limit: 50
    });
  }
});

let service: ReturnType<typeof createPlatformEmailMonitoringService> | undefined;

export const getPlatformEmailMonitoringService = () => {
  service ??= createPlatformEmailMonitoringService({
    verifyOwner: isPlatformOwner,
    repository: new PostgresLifecycleEmailMonitoringRepository(
      getDatabaseClient().db
    ),
    clock: { now: () => new Date() }
  });
  return service;
};
