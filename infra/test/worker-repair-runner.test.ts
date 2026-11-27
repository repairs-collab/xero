import { execFileSync } from 'node:child_process';
import { describe, it } from 'vitest';

describe('protected OVH worker repair', () => {
  it.skipIf(process.platform !== 'linux')('checks the release lock, target, replay risks and completion receipt before reporting recovery', () => {
    execFileSync('bash', ['deploy/ovh/run-worker-repair.test.sh']);
  });
});
