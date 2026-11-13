import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('OVH server-health installer', () => {
  it('is executable in a fresh Linux checkout for direct invocation from the runbook', () => {
    const entry = execFileSync('git', [
      'ls-files', '--stage', '--', 'deploy/ovh/install-server-health-monitor.sh'
    ], { encoding: 'utf8' });

    expect(entry.split(' ')[0]).toBe('100755');
  });

  it.skipIf(process.platform !== 'linux')('collects capacity only for the expected OVH mount', () => {
    execFileSync('bash', ['deploy/ovh/collect-server-health.test.sh']);
  });
});
