import { describe, expect, it } from 'vitest';

import {
  evaluateServerHealth,
  loadServerHealthSnapshot,
  type ServerHealthSnapshot
} from './server-health.js';

const checkedAt = '2026-11-13T01:00:00.000Z';
const now = new Date('2026-11-13T01:05:00.000Z');

const healthySnapshot = (): ServerHealthSnapshot => ({
  schemaVersion: 1,
  checkedAt,
  host: {
    uptimeSeconds: 864_000,
    cpuCores: 4,
    load1: 0.8,
    load5: 1.2,
    load15: 1.1
  },
  memory: {
    totalBytes: 8_000,
    usedBytes: 4_000,
    freeBytes: 4_000
  },
  disk: {
    totalBytes: 100_000,
    usedBytes: 50_000,
    freeBytes: 50_000
  },
  services: [
    { name: 'web', status: 'HEALTHY' },
    { name: 'worker', status: 'HEALTHY' },
    { name: 'postgres', status: 'HEALTHY' },
    { name: 'caddy', status: 'HEALTHY' }
  ]
});

describe('server health snapshot', () => {
  it('grades a fresh, healthy snapshot and derives capacity percentages', () => {
    const health = evaluateServerHealth(healthySnapshot(), now);

    expect(health.status).toBe('HEALTHY');
    expect(health.checkedAt).toBe(checkedAt);
    expect(health.ageSeconds).toBe(300);
    expect(health.memory.usedPercent).toBe(50);
    expect(health.disk.usedPercent).toBe(50);
    expect(health.host.loadPerCorePercent).toBe(30);
    expect(health.services).toEqual([
      { name: 'web', label: 'Web app', status: 'HEALTHY' },
      { name: 'worker', label: 'Worker', status: 'HEALTHY' },
      { name: 'postgres', label: 'Database', status: 'HEALTHY' },
      { name: 'caddy', label: 'Web gateway', status: 'HEALTHY' }
    ]);
  });

  it('warns at the 80 percent capacity and one-load-per-core boundaries', () => {
    const snapshot = healthySnapshot();
    snapshot.memory.usedBytes = 6_400;
    snapshot.memory.freeBytes = 1_600;
    snapshot.host.load5 = 4;

    const health = evaluateServerHealth(snapshot, now);

    expect(health.status).toBe('WARNING');
    expect(health.memory.usedPercent).toBe(80);
    expect(health.host.loadPerCorePercent).toBe(100);
  });

  it('grades critical capacity and service failures at the fixed boundaries', () => {
    const snapshot = healthySnapshot();
    snapshot.disk.usedBytes = 90_000;
    snapshot.disk.freeBytes = 10_000;
    snapshot.services[1] = { name: 'worker', status: 'DOWN' };

    const health = evaluateServerHealth(snapshot, now);

    expect(health.status).toBe('CRITICAL');
    expect(health.disk.usedPercent).toBe(90);
    expect(health.services[1]).toEqual({
      name: 'worker',
      label: 'Worker',
      status: 'DOWN'
    });
  });

  it('fails closed when the snapshot is stale', () => {
    const health = evaluateServerHealth(
      healthySnapshot(),
      new Date('2026-11-13T01:15:01.000Z')
    );

    expect(health.status).toBe('UNAVAILABLE');
    expect(health.message).toBe('Server health data is out of date.');
  });

  it('returns an unavailable view for malformed, incomplete, or oversized input', async () => {
    for (const raw of [
      '{not-json',
      JSON.stringify({ ...healthySnapshot(), services: [] }),
      'x'.repeat(65_537)
    ]) {
      const health = await loadServerHealthSnapshot({
        now,
        readText: async () => raw
      });

      expect(health.status).toBe('UNAVAILABLE');
      expect(health.message).toBe('Server health data is not available.');
    }
  });

  it('drops unknown services and extra secret-looking fields from the owner view', async () => {
    const raw = JSON.stringify({
      ...healthySnapshot(),
      hostname: 'must-not-render.example',
      environment: { DATABASE_PASSWORD: 'must-not-render' },
      services: [
        ...healthySnapshot().services,
        { name: 'unknown-admin-agent', status: 'HEALTHY', apiKey: 'must-not-render' }
      ]
    });

    const health = await loadServerHealthSnapshot({
      now,
      readText: async () => raw
    });

    expect(health.status).toBe('HEALTHY');
    expect(health.services).toHaveLength(4);
    expect(JSON.stringify(health)).not.toContain('must-not-render');
    expect(JSON.stringify(health)).not.toContain('unknown-admin-agent');
  });

  it('hides file errors behind the same safe unavailable response', async () => {
    const health = await loadServerHealthSnapshot({
      now,
      path: '/sensitive/host/path/server-health.json',
      readText: async () => {
        throw new Error('permission denied at /sensitive/host/path/server-health.json');
      }
    });

    expect(health).toEqual({
      status: 'UNAVAILABLE',
      checkedAt: null,
      ageSeconds: null,
      message: 'Server health data is not available.',
      host: null,
      memory: null,
      disk: null,
      services: []
    });
  });
});

