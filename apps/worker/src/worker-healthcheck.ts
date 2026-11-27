import { readFileSync } from 'node:fs';

import { isWorkerHeartbeatCurrent } from './worker-heartbeat.js';

const path = process.env.ACCOUNT_PULSE_WORKER_HEARTBEAT_PATH;
if (path === undefined) {
  process.exitCode = 1;
} else {
  try {
    const heartbeat: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isWorkerHeartbeatCurrent(heartbeat)) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
