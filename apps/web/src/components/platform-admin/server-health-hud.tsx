import type {
  ServerHealthStatus,
  ServerHealthView,
  ServerServiceStatus
} from '../../server/server-health.js';

const statusLabels: Record<ServerHealthStatus, string> = {
  HEALTHY: 'Healthy',
  WARNING: 'Warning',
  CRITICAL: 'Critical',
  UNAVAILABLE: 'Unavailable'
};

const serviceStatusLabels: Record<ServerServiceStatus, string> = {
  HEALTHY: 'Healthy',
  STARTING: 'Starting',
  UNHEALTHY: 'Unhealthy',
  DOWN: 'Down'
};

const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${new Intl.NumberFormat('en-AU', {
    minimumFractionDigits: unit === 0 ? 0 : 1,
    maximumFractionDigits: 1
  }).format(value)} ${units[unit]}`;
};

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400);
  if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
};

const formatAge = (seconds: number): string => {
  if (seconds < 60) return 'Checked just now';
  const minutes = Math.floor(seconds / 60);
  return `Checked ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
};

const CapacityCard = ({
  label,
  usedPercent,
  freeBytes,
  totalBytes
}: {
  label: string;
  usedPercent: number;
  freeBytes: number;
  totalBytes: number;
}) => (
  <article className="server-health-card">
    <span>{label}</span>
    <strong>{usedPercent}% used</strong>
    <div
      className="server-health-meter"
      role="meter"
      aria-label={`${label} used`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usedPercent}
    >
      <span style={{ width: `${Math.min(100, usedPercent)}%` }} />
    </div>
    <small>{formatBytes(freeBytes)} free of {formatBytes(totalBytes)}</small>
  </article>
);

export function ServerHealthHud({ health }: { health: ServerHealthView }) {
  const statusClass = health.status.toLowerCase();
  return (
    <div className="platform-page-stack">
      <header className="platform-page-heading">
        <div>
          <span className="eyebrow">Owner operations</span>
          <h1>Server health</h1>
          <p>Read-only OVH capacity and core AccountPulse service status.</p>
        </div>
      </header>

      <section
        className={`panel server-health-summary server-health-summary--${statusClass}`}
        aria-labelledby="server-health-status"
      >
        <div>
          <span className={`server-health-badge server-health-badge--${statusClass}`}>
            {statusLabels[health.status]}
          </span>
          <h2 id="server-health-status">{health.message}</h2>
        </div>
        <small>
          {health.ageSeconds === null
            ? 'No current host metrics can be shown.'
            : formatAge(health.ageSeconds)}
        </small>
      </section>

      {health.host && health.memory && health.disk ? (
        <>
          <section className="server-health-grid" aria-label="Host capacity">
            <article className="server-health-card">
              <span>Uptime</span>
              <strong>{formatUptime(health.host.uptimeSeconds)}</strong>
              <small>Since the OVH host last restarted</small>
            </article>
            <article className="server-health-card">
              <span>CPU load</span>
              <strong>{health.host.loadPerCorePercent}% per core</strong>
              <small>
                5-minute load {health.host.load5.toFixed(2)} across {health.host.cpuCores} cores
              </small>
            </article>
            <CapacityCard label="Memory" {...health.memory} />
            <CapacityCard label="Disk" {...health.disk} />
          </section>

          <section className="panel server-health-services">
            <div className="panel__heading">
              <div>
                <span className="eyebrow">Core services</span>
                <h2>Application status</h2>
              </div>
              <small>Read-only snapshot</small>
            </div>
            <div className="server-health-service-grid">
              {health.services.map((service) => (
                <article key={service.name}>
                  <strong>{service.label}</strong>
                  <span className={`server-service-status server-service-status--${service.status.toLowerCase()}`}>
                    {serviceStatusLabels[service.status]}
                  </span>
                </article>
              ))}
            </div>
          </section>

          <section className="panel server-health-thresholds" aria-label="Capacity thresholds">
            <strong>Capacity thresholds</strong>
            <span>Warning at 80%</span>
            <span>Critical at 90%</span>
            <span>Load warning at 100% per core</span>
            <span>Snapshot unavailable after 15 minutes</span>
          </section>
        </>
      ) : null}
    </div>
  );
}

