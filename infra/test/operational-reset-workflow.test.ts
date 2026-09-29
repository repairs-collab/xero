import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/operational-reset.yml'),
  'utf8'
);

const position = (source: string): number => {
  const index = workflow.indexOf(source);
  expect(index, `${source} should be present`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('protected operational reset workflow', () => {
  it('is manual-only, serialised with production deploys, and environment protected', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).toContain('environment: ${{ inputs.target_environment }}');
    expect(workflow).toContain('group: bill-chaser-production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('type: choice');
    expect(workflow).toContain('- staging');
    expect(workflow).toContain('- production');
  });

  it('requires fixed reset identity, approval, and compare-and-set inputs', () => {
    for (const name of [
      'target_environment:',
      'operation:',
      'organisation_id:',
      'reset_run_id:',
      'admin_email:',
      'deployed_commit:',
      'expected_version:',
      'acknowledgement:',
      'snapshot_id:'
    ]) {
      expect(workflow).toContain(name);
    }
    expect(workflow).toContain('git rev-parse HEAD');
    expect(workflow).toContain('DEPLOYED_WORKER_IMAGE');
    expect(workflow).toContain('WorkerTaskDefinitionArn');
  });

  it('prepares, drains, snapshots, executes, and only then restores workers', () => {
    const prepare = position('operational-reset prepare');
    const suspend = position('DRAIN_SUSPENDED');
    const stableBeforeCapture = position('# Establish a stable pre-drain task set');
    const capture = position('PRE_DRAIN_TASKS=');
    const drain = position('--desired-count 0');
    const stopped = position('DRAINED_SERVICE=');
    const snapshot = position('create-db-snapshot');
    const snapshotReady = position('db-snapshot-available');
    const execute = position('operational-reset execute');
    const restore = position('Restore the worker service');

    expect(prepare).toBeLessThan(drain);
    expect(suspend).toBeLessThan(stableBeforeCapture);
    expect(stableBeforeCapture).toBeLessThan(capture);
    expect(capture).toBeLessThan(drain);
    expect(drain).toBeLessThan(stopped);
    expect(stopped).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(snapshotReady);
    expect(snapshotReady).toBeLessThan(execute);
    expect(execute).toBeLessThan(restore);
    expect(workflow).toContain('TARGET_ENVIRONMENT}-accountpulse-${SAFE_ORG}-${GITHUB_RUN_ID}');
    expect(workflow).toContain('"DynamicScalingOutSuspended":true');
    expect(workflow).toContain('"ScheduledScalingSuspended":true');
    expect(workflow).toContain('DEFAULT_ACTIVE_SCALING');
    expect(workflow).toContain('PRE_DRAIN_TASKS');
    expect(workflow).toContain('pendingCount');
    expect(workflow).toContain('DRAIN_FAILURES');
    expect(workflow).toContain('.exitCode != 0');
  });

  it('leaves workers paused on reset failure and prints retry or abort guidance', () => {
    expect(workflow).toContain('set -Eeuo pipefail');
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain('Workers remain paused');
    expect(workflow).toContain('docs/runbooks/operational-reset.md');
    expect(workflow).not.toContain('trap restore');
    expect(workflow).toContain('write_lock reset-completed');
    expect(workflow).toContain('"$RESET_PHASE" == "reset-completed');
  });

  it('holds a durable deployment lock until reset recovery or audited abort completes', () => {
    expect(workflow).toContain('aws ssm get-parameter');
    expect(workflow).toContain('aws ssm put-parameter');
    expect(workflow).toContain('aws ssm delete-parameter');
    expect(workflow).toContain('/accountpulse/${TARGET_ENVIRONMENT}/operational-reset-lock');
    expect(position('aws ssm put-parameter')).toBeLessThan(
      position('create-db-snapshot')
    );
    expect(position('operational-reset execute')).toBeLessThan(
      workflow.lastIndexOf('aws ssm delete-parameter')
    );
  });

  it('can reuse the original validated snapshot in a newly dispatched retry', () => {
    expect(workflow).toContain('REQUESTED_SNAPSHOT_ID');
    expect(workflow).toContain('LOCK_SNAPSHOT');
    expect(workflow).not.toContain(
      '"$OPERATION" == "reset" && -n "$REQUESTED_SNAPSHOT_ID"'
    );
    expect(workflow).toContain('elif [[ -n "$LOCK_SNAPSHOT" ]]');
    expect(workflow).toContain('Retry snapshot does not match the deployment lock');
    expect(workflow).toContain('A retry snapshot requires the existing same-run deployment lock');
    expect(workflow).toContain('DBInstanceIdentifier');
    expect(workflow).toContain('Snapshot does not belong to the target database');
  });

  it('keeps abort separate from prepare, snapshot, execute, and customer activation', () => {
    const abortStart = position('if [[ "$OPERATION" == "abort" ]]');
    const abortEnd = workflow.indexOf('fi # end abort', abortStart);
    expect(abortEnd).toBeGreaterThan(abortStart);
    const abortBlock = workflow.slice(abortStart, abortEnd);
    expect(abortBlock).toContain('operational-reset abort');
    expect(abortBlock).not.toContain('operational-reset prepare');
    expect(abortBlock).not.toContain('operational-reset execute');
    expect(abortBlock).not.toContain('create-db-snapshot');
    expect(workflow).not.toContain('CUSTOMER_ROLLOUT');
    expect(workflow).not.toContain('rolloutScope');
  });

  it('never passes or prints provider and database credentials', () => {
    expect(workflow).not.toContain('DATABASE_PASSWORD');
    expect(workflow).not.toContain('XERO_API_CREDENTIALS');
    expect(workflow).not.toContain('SINCH_API_CREDENTIALS');
    expect(workflow).not.toContain('aws secretsmanager get-secret-value');
  });
});
