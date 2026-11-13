import { describe, expect, it } from 'vitest';

import {
  evaluateServerHealth,
  loadServerHealthSnapshot,
  type ServerHealthSnapshot
} from './server-health.js';

const checkedAt = '2026-11-13T01:00:00.000Z';
const now = new Date('2026-11-13T01:05:00.000Z');
const additionalDisk = {
  diskId: 698708443,
  totalBytes: 200_000_000_000,
  usedBytes: 75_000_000_000,
  freeBytes: 125_000_000_000
} as const;

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
  additionalDisk,
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
    expect(health.memory?.usedPercent).toBe(50);
    expect(health.disk?.usedPercent).toBe(50);
    expect(health).toMatchObject({ additionalDisk: { ...additionalDisk, usedPercent: 38 } });
    expect(health.host?.loadPerCorePercent).toBe(30);
    expect(health.services).toEqual([
      { name: 'web', label: 'Web app', status: 'HEALTHY' },
      { name: 'worker', label: 'Worker', status: 'HEALTHY' },
      { name: 'postgres', label: 'Database', status: 'HEALTHY' },
      { name: 'caddy', label: 'Web gateway', status: 'HEALTHY' }
    ]);
  });

  it.each([
    ['memory', 79.9, 'HEALTHY', 80],
    ['disk', 79.9, 'HEALTHY', 80],
    ['additionalDisk', 79.9, 'HEALTHY', 80],
    ['memory', 89.9, 'WARNING', 90],
    ['disk', 89.9, 'WARNING', 90],
    ['additionalDisk', 89.9, 'WARNING', 90],
    ['disk', 80, 'WARNING', 80],
    ['disk', 90, 'CRITICAL', 90],
    ['additionalDisk', 80, 'WARNING', 80],
    ['additionalDisk', 90, 'CRITICAL', 90]
  ] as const)('grades %s at %s percent as %s', (metric, usage, status, displayPercent) => {
    const snapshot = healthySnapshot();
    const usedBytes = Math.round(usage * 10);
    const health = evaluateServerHealth({
      ...snapshot,
      [metric]: { ...snapshot[metric], totalBytes: 1_000, usedBytes, freeBytes: 1_000 - usedBytes }
    }, now);

    expect(health.status).toBe(status);
    expect(health).toMatchObject({ [metric]: { usedPercent: displayPercent } });
  });

  it.each([
    [3.99, 'HEALTHY', 100],
    [4, 'WARNING', 100],
    [5.99, 'WARNING', 150],
    [6, 'CRITICAL', 150]
  ] as const)('grades a five-minute load of %s across four cores as %s', (load5, status, displayPercent) => {
    const snapshot = healthySnapshot();
    snapshot.host.load5 = load5;
    const health = evaluateServerHealth(snapshot, now);

    expect(health.status).toBe(status);
    expect(health.host?.loadPerCorePercent).toBe(displayPercent);
  });

  it('warns at the 80 percent capacity and one-load-per-core boundaries', () => {
    const snapshot = healthySnapshot();
    snapshot.memory.usedBytes = 6_400;
    snapshot.memory.freeBytes = 1_600;
    snapshot.host.load5 = 4;

    const health = evaluateServerHealth(snapshot, now);

    expect(health.status).toBe('WARNING');
    expect(health.memory?.usedPercent).toBe(80);
    expect(health.host?.loadPerCorePercent).toBe(100);
  });

  it('grades critical capacity and service failures at the fixed boundaries', () => {
    const snapshot = healthySnapshot();
    snapshot.disk.usedBytes = 90_000;
    snapshot.disk.freeBytes = 10_000;
    snapshot.services[1] = { name: 'worker', status: 'DOWN' };

    const health = evaluateServerHealth(snapshot, now);

    expect(health.status).toBe('CRITICAL');
    expect(health.disk?.usedPercent).toBe(90);
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

  it('fails closed when the host timestamp is materially in the future', () => {
    const snapshot = healthySnapshot();
    snapshot.checkedAt = '2026-11-13T01:10:01.000Z';

    const health = evaluateServerHealth(snapshot, now);

    expect(health.status).toBe('UNAVAILABLE');
    expect(health.message).toBe('Server health data is not available.');
  });

  it.each([
    ['2026-11-13T01:00:00Z', '2026-11-13T01:00:00.000Z'],
    ['2026-11-13T01:00:00.12Z', '2026-11-13T01:00:00.120Z']
  ])('canonicalizes the UTC check time %s', async (timestamp, canonical) => {
    const health = await loadServerHealthSnapshot({
      now,
      readText: () => Promise.resolve(JSON.stringify({ ...healthySnapshot(), checkedAt: timestamp }))
    });

    expect(health.status).toBe('HEALTHY');
    expect(health.checkedAt).toBe(canonical);
  });

  it.each([
    'Fri, 13 Nov 2026 01:00:00 GMT (token=/srv/private)',
    '2026-11-13 01:00:00Z (token=/srv/private)',
    '2026-11-13T01:00:00+00:00',
    '2026-11-13T01:00:00',
    '2026-11-13T01:00:00Z\n',
    '2026-11-13T24:00:00Z',
    '2026-02-30T01:00:00Z'
  ])('rejects an invalid UTC date input %j', async (timestamp) => {
    const snapshot = { ...healthySnapshot(), checkedAt: timestamp };
    const checkTime = new Date(Date.parse(timestamp) || now.getTime());
    const health = await loadServerHealthSnapshot({
      now: checkTime,
      readText: () => Promise.resolve(JSON.stringify(snapshot))
    });

    expect(health).toMatchObject({ status: 'UNAVAILABLE', checkedAt: null });
    expect(evaluateServerHealth(snapshot, checkTime)).toMatchObject({
      status: 'UNAVAILABLE',
      checkedAt: null
    });
  });

  it.each([
    ['an older snapshot', undefined],
    ['an unmounted disk', null],
    ['an unrecognized disk ID', { ...additionalDisk, diskId: 123 }]
  ])('makes the view unavailable for %s', async (_label, disk) => {
    const health = await loadServerHealthSnapshot({
      now,
      readText: () => Promise.resolve(JSON.stringify({ ...healthySnapshot(), additionalDisk: disk }))
    });

    expect(health).toMatchObject({ status: 'UNAVAILABLE', additionalDisk: null });
  });

  it('returns an unavailable view for malformed, incomplete, or oversized input', async () => {
    for (const raw of [
      '{not-json',
      JSON.stringify({ ...healthySnapshot(), services: [] }),
      'x'.repeat(65_537)
    ]) {
      const health = await loadServerHealthSnapshot({
        now,
        readText: () => Promise.resolve(raw)
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
      additionalDisk: { ...additionalDisk, mount: '/srv/data', device: '/dev/sdb' },
      services: [
        ...healthySnapshot().services,
        { name: 'unknown-admin-agent', status: 'HEALTHY', apiKey: 'must-not-render' }
      ]
    });

    const health = await loadServerHealthSnapshot({
      now,
      readText: () => Promise.resolve(raw)
    });

    expect(health.status).toBe('HEALTHY');
    expect(health.services).toHaveLength(4);
    expect(JSON.stringify(health)).not.toContain('must-not-render');
    expect(JSON.stringify(health)).not.toContain('unknown-admin-agent');
    expect(JSON.stringify(health)).not.toContain('/srv/data');
    expect(JSON.stringify(health)).not.toContain('/dev/sdb');
  });

  it('hides file errors behind the same safe unavailable response', async () => {
    const health = await loadServerHealthSnapshot({
      now,
      path: '/sensitive/host/path/server-health.json',
      readText: () => Promise.reject(
        new Error('permission denied at /sensitive/host/path/server-health.json')
      )
    });

    expect(health).toEqual({
      status: 'UNAVAILABLE',
      checkedAt: null,
      ageSeconds: null,
      message: 'Server health data is not available.',
      host: null,
      memory: null,
      disk: null,
      additionalDisk: null,
      services: []
    });
  });
});

