import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shell =
  process.platform === 'win32'
    ? resolve(
        dirname(
          dirname(
            execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' })
              .trim()
              .split(/\r?\n/)[0]!
          )
        ),
        'usr',
        'bin',
        'sh.exe'
      )
    : '/bin/bash';

describe('OVH release worker readiness', () => {
  it('accepts only the running candidate with a healthy probe and no restarts', () => {
    const release = readFileSync(
      resolve(process.cwd(), 'deploy/ovh/release.sh'),
      'utf8'
    );
    const workerGate = release.slice(
      release.indexOf('wait_for_worker_readiness() {'),
      release.indexOf('\ncandidate_compose=')
    );
    const script = `${workerGate}
      active_compose=(fake_compose)
      fake_compose() { echo worker-container; }
      docker() { echo "$worker_state"; }
      candidate_worker_image=sha256:candidate

      for worker_state in \
        'sha256:candidate running healthy 0' \
        'sha256:candidate restarting starting 1' \
        'sha256:candidate running healthy 1' \
        'sha256:candidate running unhealthy 0' \
        'sha256:candidate running none 0' \
        'sha256:previous running healthy 0'; do
        if wait_for_worker_readiness; then echo accepted; else echo rejected; fi
      done
    `;
    const result = spawnSync(shell, ['-s'], {
      input: script,
      encoding: 'utf8',
      timeout: 10_000
    });

    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      'accepted',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected'
    ]);
  }, 15_000);
});
