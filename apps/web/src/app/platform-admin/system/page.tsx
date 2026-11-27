import { randomUUID } from 'node:crypto';

import { loadLatestWorkerRepair, loadWorkerRepairRunnerAvailable } from '@bc5000/db/web';

import { ServerHealthHud } from '../../../components/platform-admin/server-health-hud.js';
import type { WorkerRepairFormAction } from '../../../components/platform-admin/worker-repair-form.js';
import { WorkerRepairPanel } from '../../../components/platform-admin/worker-repair-panel.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';
import { getDatabaseClient } from '../../../server/runtime.js';
import { loadServerHealthSnapshot } from '../../../server/server-health.js';
import { submitWorkerRepair } from './actions.js';

async function loadRepairControl() {
  try {
    const database = getDatabaseClient().db;
    const [latest, runnerAvailable] = await Promise.all([
      loadLatestWorkerRepair(database),
      loadWorkerRepairRunnerAvailable(database)
    ]);
    return { latest, runnerAvailable };
  } catch {
    return null;
  }
}

export default async function PlatformServerHealthPage() {
  await requirePlatformOwnerPage('/platform-admin/system');
  const [health, repair] = await Promise.all([loadServerHealthSnapshot(), loadRepairControl()]);
  const requestId = randomUUID();
  const requestRepair: WorkerRepairFormAction = async (_previousOutcome, formData) => {
    'use server';
    return submitWorkerRepair(requestId, formData);
  };
  return (
    <div className="platform-page-stack">
      <ServerHealthHud health={health} />
      <WorkerRepairPanel repair={repair} action={requestRepair} now={new Date()} />
    </div>
  );
}

