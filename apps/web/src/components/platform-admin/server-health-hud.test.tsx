import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ServerHealthView } from '../../server/server-health.js';
import { ServerHealthHud } from './server-health-hud.js';

const healthy: ServerHealthView = {
  status: 'HEALTHY',
  checkedAt: '2026-11-13T01:00:00.000Z',
  ageSeconds: 300,
  message: 'All monitored server systems are healthy.',
  host: {
    uptimeSeconds: 864_000,
    cpuCores: 4,
    load1: 0.8,
    load5: 1.2,
    load15: 1.1,
    loadPerCorePercent: 30
  },
  memory: {
    totalBytes: 8_000_000_000,
    usedBytes: 4_000_000_000,
    freeBytes: 4_000_000_000,
    usedPercent: 50
  },
  disk: {
    totalBytes: 100_000_000_000,
    usedBytes: 50_000_000_000,
    freeBytes: 50_000_000_000,
    usedPercent: 50
  },
  additionalDisk: {
    diskId: 698708443,
    totalBytes: 200_000_000_000,
    usedBytes: 75_000_000_000,
    freeBytes: 125_000_000_000,
    usedPercent: 38
  },
  services: [
    { name: 'web', label: 'Web app', status: 'HEALTHY' },
    { name: 'worker', label: 'Worker', status: 'HEALTHY' },
    { name: 'postgres', label: 'Database', status: 'HEALTHY' },
    { name: 'caddy', label: 'Web gateway', status: 'HEALTHY' }
  ]
};

describe('owner server health HUD', () => {
  it('shows capacity, load, uptime, freshness, thresholds, and core services', () => {
    const html = renderToStaticMarkup(<ServerHealthHud health={healthy} />);

    expect(html).toContain('Server health');
    expect(html).toContain('Healthy');
    expect(html).toContain('Checked 5 minutes ago');
    expect(html).toContain('Last checked');
    expect(html).toContain('dateTime="2026-11-13T01:00:00.000Z"');
    expect(html).toContain('10 days');
    expect(html).toContain('5-minute load 1.20 across 4 cores');
    expect(html).toContain('50% used');
    expect(html).toContain('4.0 GB free');
    expect(html).toContain('50.0 GB free');
    expect(html).toContain('Database');
    expect(html).toContain('Web gateway');
    expect(html).toContain('Warning at 80%');
    expect(html).toContain('Critical at 90%');
  });

  it('shows separate root and OVH additional storage metrics using safe labels', () => {
    const html = renderToStaticMarkup(<ServerHealthHud health={healthy} />);

    expect(html).toContain('Root disk');
    expect(html).toContain('Additional storage');
    expect(html).toContain('OVH disk 698708443');
    expect(html).toContain('38% used');
    expect(html).toContain('75.0 GB used');
    expect(html).toContain('125.0 GB free of 200.0 GB');
    expect(html).not.toContain('/srv/data');
    expect(html).not.toContain('/dev/sdb');
  });

  it('uses urgent presentation for a critical snapshot without adding controls', () => {
    const html = renderToStaticMarkup(
      <ServerHealthHud
        health={{
          ...healthy,
          status: 'CRITICAL',
          message: 'Server capacity or a monitored service needs urgent attention.',
          services: healthy.services.map((service) =>
            service.name === 'worker' ? { ...service, status: 'DOWN' } : service
          )
        }}
      />
    );

    expect(html).toContain('Critical');
    expect(html).toContain('needs urgent attention');
    expect(html).toContain('Down');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Restart');
    expect(html).not.toContain('Run command');
  });

  it('renders an explicit safe unavailable state without infrastructure details', () => {
    const html = renderToStaticMarkup(
      <ServerHealthHud
        health={{
          status: 'UNAVAILABLE',
          checkedAt: null,
          ageSeconds: null,
          message: 'Server health data is not available.',
          host: null,
          memory: null,
          disk: null,
          additionalDisk: null,
          services: []
        }}
      />
    );

    expect(html).toContain('Unavailable');
    expect(html).toContain('Server health data is not available.');
    expect(html).toContain('No current host metrics can be shown.');
    expect(html).not.toContain('/run/');
    expect(html).not.toContain('SERVER_HEALTH_SNAPSHOT_PATH');
    expect(html).not.toContain('Docker');
  });
});

