import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('protected OVH worker repair', () => {
  it('enables the repair runner only after the protected application release', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    const release = workflow.indexOf('name: Run migration and health-checked release');
    const install = workflow.indexOf('name: Enable the OVH Owner repair runner');
    expect(release).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(release);
    expect(workflow.slice(install)).toContain('sudo -n -- bash ./install-worker-repair.sh');
    expect(workflow.slice(install)).toContain('systemctl is-active accountpulse-worker-repair.timer');
  });

  it.skipIf(process.platform !== 'linux')('checks the release lock, target, replay risks and completion receipt before reporting recovery', () => {
    execFileSync('bash', ['deploy/ovh/run-worker-repair.test.sh']);
  });
});
