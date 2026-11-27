import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformOwnerPage: vi.fn().mockResolvedValue({
    userId: 'verified-owner',
    displayName: 'Owner',
    memberships: []
  }),
  getDatabaseClient: vi.fn().mockReturnValue({ db: {} }),
  loadLatestWorkerRepair: vi.fn(),
  loadWorkerRepairRunnerAvailable: vi.fn(),
  loadServerHealthSnapshot: vi.fn().mockResolvedValue({
    status: 'UNAVAILABLE',
    checkedAt: null,
    ageSeconds: null,
    message: 'Server health data is not available.',
    host: null,
    memory: null,
    disk: null,
    additionalDisk: null,
    services: []
  })
}));

vi.mock('../../../server/platform-page-authorization.js', () => ({
  requirePlatformOwnerPage: mocks.requirePlatformOwnerPage
}));

vi.mock('../../../server/server-health.js', () => ({
  loadServerHealthSnapshot: mocks.loadServerHealthSnapshot
}));

vi.mock('../../../server/runtime.js', () => ({
  getDatabaseClient: mocks.getDatabaseClient
}));

vi.mock('@bc5000/db/web', () => ({
  loadLatestWorkerRepair: mocks.loadLatestWorkerRepair,
  loadWorkerRepairRunnerAvailable: mocks.loadWorkerRepairRunnerAvailable,
  workerRepairCooldownMs: 10 * 60_000
}));

vi.mock('./actions.js', () => ({ submitWorkerRepair: vi.fn() }));

import PlatformServerHealthPage from './page.js';

describe('platform owner server health page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T03:00:00.000Z'));
    mocks.loadLatestWorkerRepair.mockResolvedValue(null);
    mocks.loadWorkerRepairRunnerAvailable.mockResolvedValue(true);
  });

  afterEach(() => vi.useRealTimers());

  it('authorizes the owner route before loading and rendering the safe snapshot', async () => {
    const element = await PlatformServerHealthPage();
    const html = renderToStaticMarkup(element);

    expect(mocks.requirePlatformOwnerPage).toHaveBeenCalledWith(
      '/platform-admin/system'
    );
    expect(mocks.loadServerHealthSnapshot).toHaveBeenCalledOnce();
    expect(html).toContain('Server health data is not available.');
    expect(html).toContain('Request worker repair');
    expect(html).toContain('Refresh repair status');
    expect(html).toMatch(/<input(?=[^>]*name="confirmed")(?=[^>]*required)[^>]*>/u);
    expect(html).not.toContain('name="requestId"');
    expect(html).not.toContain('name="command"');
    expect(html).not.toContain('name="target"');
  });

  it('checks authorization before loading operation history or availability', async () => {
    mocks.requirePlatformOwnerPage.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(PlatformServerHealthPage()).rejects.toThrow('Forbidden');
    expect(mocks.getDatabaseClient).not.toHaveBeenCalled();
    expect(mocks.loadLatestWorkerRepair).not.toHaveBeenCalled();
    expect(mocks.loadWorkerRepairRunnerAvailable).not.toHaveBeenCalled();
  });

  it('shows before and after worker health and prevents another request during cooldown', async () => {
    mocks.loadLatestWorkerRepair.mockResolvedValue({
      status: 'SUCCEEDED',
      resultCode: 'RESTARTED_HEALTHY',
      beforeHealth: 'DOWN',
      afterHealth: 'HEALTHY',
      requestedAt: new Date('2026-11-27T02:56:00.000Z'),
      claimedAt: new Date('2026-11-27T02:57:00.000Z'),
      completedAt: new Date('2026-11-27T02:58:00.000Z')
    });
    const html = renderToStaticMarkup(await PlatformServerHealthPage());

    expect(html).toContain('Worker restarted and passed the readiness check.');
    expect(html).toContain('Worker before');
    expect(html).toContain('Down');
    expect(html).toContain('Worker after');
    expect(html).toContain('Healthy');
    expect(html).toContain('2026-11-27T03:06:00.000Z');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Request worker repair<\/button>/u);
  });

  it('keeps repair unavailable when the host runner is offline', async () => {
    mocks.loadWorkerRepairRunnerAvailable.mockResolvedValue(false);
    const html = renderToStaticMarkup(await PlatformServerHealthPage());

    expect(html).toContain('The host repair service is unavailable.');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Request worker repair<\/button>/u);
  });

  it('allows another request once the cooldown has finished and the runner is available', async () => {
    mocks.loadLatestWorkerRepair.mockResolvedValue({
      status: 'SKIPPED',
      resultCode: 'STARTUP_IN_PROGRESS',
      beforeHealth: 'STARTING',
      afterHealth: null,
      requestedAt: new Date('2026-11-27T02:50:00.000Z'),
      claimedAt: new Date('2026-11-27T02:51:00.000Z'),
      completedAt: new Date('2026-11-27T02:51:00.000Z')
    });
    const html = renderToStaticMarkup(await PlatformServerHealthPage());

    expect(html).toContain('The worker is starting. Refresh repair status after startup.');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Request worker repair<\/button>/u);
  });

  it('shows the queued request and suppresses duplicate submissions', async () => {
    mocks.loadLatestWorkerRepair.mockResolvedValue({
      status: 'PENDING',
      resultCode: null,
      beforeHealth: null,
      afterHealth: null,
      requestedAt: new Date('2026-11-27T02:59:00.000Z'),
      claimedAt: null,
      completedAt: null
    });
    const html = renderToStaticMarkup(await PlatformServerHealthPage());

    expect(html).toContain('Waiting for the host');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Request worker repair<\/button>/u);
  });
});

