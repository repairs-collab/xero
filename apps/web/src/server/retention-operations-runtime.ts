import {
  createRetentionOperationsService,
  PostgresRetentionOperationsRepository
} from './retention-operations.js';
import { isPlatformOwner } from './platform-authorization.js';
import { getDatabaseClient } from './runtime.js';

let service: ReturnType<typeof createRetentionOperationsService> | undefined;

export const getRetentionOperationsService = () => {
  service ??= createRetentionOperationsService({
    verifyOwner: isPlatformOwner,
    repository: new PostgresRetentionOperationsRepository(
      getDatabaseClient().db
    )
  });
  return service;
};
