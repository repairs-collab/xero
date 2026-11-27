import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const heartbeatIntervalMs = 15_000;
const maximumHeartbeatAgeMs = 60_000;

function readProcessStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the command name start at field 3. The start time is field 22.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const state = fields[0];
    const parentPid = fields[1];
    const startTicks = fields[19];
    // The health check must match the PID 1 worker or its entrypoint's child.
    if (
      (pid !== 1 && parentPid !== '1') ||
      state === 'Z' ||
      state === 'X' ||
      startTicks === undefined ||
      !/^\d+$/.test(startTicks)
    ) {
      return undefined;
    }
    return startTicks;
  } catch {
    return undefined;
  }
}

export function isWorkerHeartbeatCurrent(
  heartbeat: unknown,
  readStartTicks = readProcessStartTicks,
  now = Date.now()
): boolean {
  if (
    typeof heartbeat !== 'object' ||
    heartbeat === null ||
    !('pid' in heartbeat) ||
    !('processStartTicks' in heartbeat) ||
    !('updatedAt' in heartbeat)
  ) {
    return false;
  }
  const { pid, processStartTicks, updatedAt } = heartbeat;
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    typeof processStartTicks !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return false;
  }
  const age = now - Date.parse(updatedAt);
  return (
    age >= 0 &&
    age <= maximumHeartbeatAgeMs &&
    processStartTicks === readStartTicks(pid)
  );
}

export function startWorkerHeartbeat(path: string): () => void {
  const pid = process.pid;
  const processStartTicks = readProcessStartTicks(pid);
  if (processStartTicks === undefined) {
    throw new Error('Unable to identify the container worker process');
  }
  const temporaryPath = `${path}.${pid}.tmp`;
  const writeHeartbeat = () => {
    const heartbeat = { pid, processStartTicks, updatedAt: new Date().toISOString() };
    writeFileSync(temporaryPath, JSON.stringify(heartbeat), { mode: 0o600 });
    renameSync(temporaryPath, path);
  };
  writeHeartbeat();
  const interval = setInterval(() => {
    try {
      writeHeartbeat();
    } catch (error) {
      console.error('Failed to refresh worker heartbeat', error);
    }
  }, heartbeatIntervalMs);
  interval.unref();

  return () => {
    clearInterval(interval);
    try {
      rmSync(path, { force: true });
      rmSync(temporaryPath, { force: true });
    } catch (error) {
      console.warn('Failed to remove worker heartbeat', error);
    }
  };
}
