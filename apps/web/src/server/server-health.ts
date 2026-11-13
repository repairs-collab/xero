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

const ADDITIONAL_DISK_ID = 698708443;

interface Capacity {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

interface AdditionalDisk extends Capacity {
  diskId: typeof ADDITIONAL_DISK_ID;
}

interface CapacityView extends Capacity {
  usedPercent: number;
}

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
  memory: Capacity;
  disk: Capacity;
  additionalDisk: AdditionalDisk;
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
  memory: CapacityView | null;
  disk: CapacityView | null;
  additionalDisk: (AdditionalDisk & CapacityView) | null;
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
  additionalDisk: null,
  services: []
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const parseCapacity = (value: unknown): Capacity | null => {
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
  if (typeof checkedAt !== 'string') return null;

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
  const additionalDisk =
    isRecord(value.additionalDisk) && value.additionalDisk.diskId === ADDITIONAL_DISK_ID
      ? parseCapacity(value.additionalDisk)
      : null;
  if (!memory || !disk || !additionalDisk || !Array.isArray(value.services)) return null;

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
    additionalDisk: { ...additionalDisk, diskId: ADDITIONAL_DISK_ID },
    services
  };
};

const parseUtcTimestamp = (value: string): Date | null => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match || match[0] !== value) return null;

  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const timestamp = new Date(canonical);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === canonical
    ? timestamp
    : null;
};

const usedRatio = ({ usedBytes, totalBytes }: Capacity): number =>
  usedBytes / totalBytes;

export const evaluateServerHealth = (
  snapshot: ServerHealthSnapshot,
  now = new Date()
): ServerHealthView => {
  const checkedAt = parseUtcTimestamp(snapshot.checkedAt);
  if (!checkedAt) return unavailable();
  const clockDifferenceSeconds = Math.floor((now.getTime() - checkedAt.getTime()) / 1_000);
  if (clockDifferenceSeconds < -300) return unavailable();
  const ageSeconds = Math.max(0, clockDifferenceSeconds);
  if (ageSeconds > STALE_AFTER_SECONDS) {
    return unavailable('Server health data is out of date.');
  }

  const memoryUsedRatio = usedRatio(snapshot.memory);
  const diskUsedRatio = usedRatio(snapshot.disk);
  const additionalDiskUsedRatio = usedRatio(snapshot.additionalDisk);
  const maxUsedRatio = Math.max(memoryUsedRatio, diskUsedRatio, additionalDiskUsedRatio);
  const loadPerCoreRatio = snapshot.host.load5 / snapshot.host.cpuCores;
  const serviceStatuses = snapshot.services.map((service) => ({
    ...service,
    label: serviceLabels[service.name]
  }));

  const critical =
    maxUsedRatio >= 0.9 ||
    loadPerCoreRatio >= 1.5 ||
    serviceStatuses.some(({ status }) => status === 'UNHEALTHY' || status === 'DOWN');
  const warning =
    maxUsedRatio >= 0.8 ||
    loadPerCoreRatio >= 1 ||
    serviceStatuses.some(({ status }) => status === 'STARTING');
  const status: ServerHealthStatus = critical
    ? 'CRITICAL'
    : warning
      ? 'WARNING'
      : 'HEALTHY';

  return {
    status,
    checkedAt: checkedAt.toISOString(),
    ageSeconds,
    message:
      status === 'CRITICAL'
        ? 'Server capacity or a monitored service needs urgent attention.'
        : status === 'WARNING'
          ? 'Server capacity or a monitored service needs attention.'
          : 'All monitored server systems are healthy.',
    host: {
      ...snapshot.host,
      loadPerCorePercent: Math.round(loadPerCoreRatio * 100)
    },
    memory: {
      ...snapshot.memory,
      usedPercent: Math.round(memoryUsedRatio * 100)
    },
    disk: {
      ...snapshot.disk,
      usedPercent: Math.round(diskUsedRatio * 100)
    },
    additionalDisk: {
      ...snapshot.additionalDisk,
      usedPercent: Math.round(additionalDiskUsedRatio * 100)
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

