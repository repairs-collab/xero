import { readFile } from 'node:fs/promises';

export const CORE_SERVER_SERVICES = [
  'web',
  'worker',
  'postgres',
  'caddy'
] as const;

export type CoreServerService = (typeof CORE_SERVER_SERVICES)[number];
export type ServerServiceStatus = 'HEALTHY' | 'STARTING' | 'UNHEALTHY' | 'DOWN';
export type ServerHealthStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNAVAILABLE';

export interface ServerHealthSnapshot {
  schemaVersion: 1;
  checkedAt: string;
  host: {
    uptimeSeconds: number;
    cpuCores: number;
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
  };
  services: Array<{
    name: CoreServerService;
    status: ServerServiceStatus;
  }>;
}

export interface ServerHealthView {
  status: ServerHealthStatus;
  checkedAt: string | null;
  ageSeconds: number | null;
  message: string;
  host: {
    uptimeSeconds: number;
    cpuCores: number;
    load1: number;
    load5: number;
    load15: number;
    loadPerCorePercent: number;
  } | null;
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  } | null;
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  } | null;
  services: Array<{
    name: CoreServerService;
    label: string;
    status: ServerServiceStatus;
  }>;
}

const MAX_SNAPSHOT_BYTES = 65_536;
const STALE_AFTER_SECONDS = 15 * 60;

const serviceLabels: Record<CoreServerService, string> = {
  web: 'Web app',
  worker: 'Worker',
  postgres: 'Database',
  caddy: 'Web gateway'
};

const unavailable = (
  message = 'Server health data is not available.'
): ServerHealthView => ({
  status: 'UNAVAILABLE',
  checkedAt: null,
  ageSeconds: null,
  message,
  host: null,
  memory: null,
  disk: null,
  services: []
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const parseCapacity = (
  value: unknown
): ServerHealthSnapshot['memory'] | null => {
  if (!isRecord(value)) return null;
  const { totalBytes, usedBytes, freeBytes } = value;
  if (
    !isNonNegativeSafeInteger(totalBytes) || totalBytes === 0 ||
    !isNonNegativeSafeInteger(usedBytes) || usedBytes > totalBytes ||
    !isNonNegativeSafeInteger(freeBytes) || freeBytes > totalBytes
  ) return null;
  return { totalBytes, usedBytes, freeBytes };
};

const parseSnapshot = (raw: string): ServerHealthSnapshot | null => {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) return null;

  const checkedAt = value.checkedAt;
  if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) {
    return null;
  }

  if (!isRecord(value.host)) return null;
  const { uptimeSeconds, cpuCores, load1, load5, load15 } = value.host;
  if (
    !isNonNegativeSafeInteger(uptimeSeconds) ||
    !isNonNegativeSafeInteger(cpuCores) || cpuCores === 0 ||
    !isNonNegativeFinite(load1) ||
    !isNonNegativeFinite(load5) ||
    !isNonNegativeFinite(load15)
  ) return null;

  const memory = parseCapacity(value.memory);
  const disk = parseCapacity(value.disk);
  if (!memory || !disk || !Array.isArray(value.services)) return null;

  const allowedNames = new Set<string>(CORE_SERVER_SERVICES);
  const allowedStatuses = new Set<ServerServiceStatus>([
    'HEALTHY',
    'STARTING',
    'UNHEALTHY',
    'DOWN'
  ]);
  const services: ServerHealthSnapshot['services'] = [];
  const seen = new Set<CoreServerService>();
  for (const candidate of value.services) {
    if (!isRecord(candidate) || typeof candidate.name !== 'string') continue;
    if (!allowedNames.has(candidate.name)) continue;
    const name = candidate.name as CoreServerService;
    if (
      seen.has(name) ||
      typeof candidate.status !== 'string' ||
      !allowedStatuses.has(candidate.status as ServerServiceStatus)
    ) return null;
    seen.add(name);
    services.push({
      name,
      status: candidate.status as ServerServiceStatus
    });
  }
  if (seen.size !== CORE_SERVER_SERVICES.length) return null;
  services.sort(
    (left, right) =>
      CORE_SERVER_SERVICES.indexOf(left.name) - CORE_SERVER_SERVICES.indexOf(right.name)
  );

  return {
    schemaVersion: 1,
    checkedAt,
    host: { uptimeSeconds, cpuCores, load1, load5, load15 },
    memory,
    disk,
    services
  };
};

const percent = (used: number, total: number): number =>
  Math.round((used / total) * 100);

export const evaluateServerHealth = (
  snapshot: ServerHealthSnapshot,
  now = new Date()
): ServerHealthView => {
  const checkedAtMs = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return unavailable();
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - checkedAtMs) / 1_000));
  if (ageSeconds > STALE_AFTER_SECONDS) {
    return unavailable('Server health data is out of date.');
  }

  const memoryUsedPercent = percent(snapshot.memory.usedBytes, snapshot.memory.totalBytes);
  const diskUsedPercent = percent(snapshot.disk.usedBytes, snapshot.disk.totalBytes);
  const loadPerCorePercent = Math.round(
    (snapshot.host.load5 / snapshot.host.cpuCores) * 100
  );
  const serviceStatuses = snapshot.services.map((service) => ({
    ...service,
    label: serviceLabels[service.name]
  }));

  const critical =
    memoryUsedPercent >= 90 ||
    diskUsedPercent >= 90 ||
    loadPerCorePercent >= 150 ||
    serviceStatuses.some(({ status }) => status === 'UNHEALTHY' || status === 'DOWN');
  const warning =
    memoryUsedPercent >= 80 ||
    diskUsedPercent >= 80 ||
    loadPerCorePercent >= 100 ||
    serviceStatuses.some(({ status }) => status === 'STARTING');
  const status: ServerHealthStatus = critical
    ? 'CRITICAL'
    : warning
      ? 'WARNING'
      : 'HEALTHY';

  return {
    status,
    checkedAt: snapshot.checkedAt,
    ageSeconds,
    message:
      status === 'CRITICAL'
        ? 'Server capacity or a monitored service needs urgent attention.'
        : status === 'WARNING'
          ? 'Server capacity or a monitored service needs attention.'
          : 'All monitored server systems are healthy.',
    host: {
      ...snapshot.host,
      loadPerCorePercent
    },
    memory: {
      ...snapshot.memory,
      usedPercent: memoryUsedPercent
    },
    disk: {
      ...snapshot.disk,
      usedPercent: diskUsedPercent
    },
    services: serviceStatuses
  };
};

export const loadServerHealthSnapshot = async ({
  path = process.env.SERVER_HEALTH_SNAPSHOT_PATH ??
    '/run/accountpulse-server-health/server-health.json',
  now = new Date(),
  readText = (filePath: string) => readFile(filePath, 'utf8')
}: {
  path?: string;
  now?: Date;
  readText?: (path: string) => Promise<string>;
} = {}): Promise<ServerHealthView> => {
  try {
    const raw = await readText(path);
    const snapshot = parseSnapshot(raw);
    return snapshot ? evaluateServerHealth(snapshot, now) : unavailable();
  } catch {
    return unavailable();
  }
};

