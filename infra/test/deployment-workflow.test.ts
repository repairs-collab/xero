import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/deploy.yml'),
  'utf8'
);

describe('deployment image scanning', () => {
  it('retries scan-on-push results through ECR eventual consistency', () => {
    expect(workflow).not.toContain('start-image-scan');
    expect(workflow).not.toContain('aws ecr wait image-scan-complete');
    expect(workflow).toContain('for ATTEMPT in {1..30}; do');
    expect(workflow).toContain('STATUS=$(aws ecr describe-image-scan-findings');
    expect(workflow).toContain('if [[ "$STATUS" == "COMPLETE" ]]; then');
    expect(workflow).toContain('if [[ "$STATUS" == "FAILED" ]]; then');
    expect(workflow).toContain('sleep 5');
    expect(workflow).toContain('if [[ "$STATUS" != "COMPLETE" ]]; then');
  });

  it('parses and rejects numeric critical or high findings', () => {
    expect(workflow).toContain('read -r CRITICAL HIGH <<< "$FINDINGS"');
    expect(workflow).toContain('CRITICAL=${CRITICAL/None/0}');
    expect(workflow).toContain('HIGH=${HIGH/None/0}');
    expect(workflow).toContain('if (( CRITICAL > 0 || HIGH > 0 )); then');
    expect(workflow).not.toContain('"None\\tNone"');
  });

  it('uses exact stack outputs for one-off migration tasks', () => {
    expect(workflow).toContain('WorkerClusterName');
    expect(workflow).toContain('WorkerServiceName');
    expect(workflow).toContain('WorkerTaskDefinitionArn');
    expect(workflow).not.toContain('aws ecs list-clusters');
    expect(workflow).not.toContain('aws ecs list-services');
  });

  it('cannot invoke reset or customer activation from a normal deployment', () => {
    expect(workflow).not.toContain('/app/worker.mjs","operational-reset');
    expect(workflow).not.toContain('CUSTOMER_ROLLOUT');
    expect(workflow).not.toContain('rolloutScope');
  });

  it('refuses to deploy while a durable operational-reset lock exists', () => {
    expect(workflow.match(/Refuse deployment during protected reset/g)).toHaveLength(2);
    expect(workflow.match(/aws ssm get-parameter/g)).toHaveLength(2);
    expect(workflow.match(/ParameterNotFound/g)).toHaveLength(2);
    expect(workflow.match(/Unable to verify the protected-reset lock/g)).toHaveLength(2);
    expect(workflow).toContain('/accountpulse/staging/operational-reset-lock');
    expect(workflow).toContain('/accountpulse/production/operational-reset-lock');
    expect(workflow.indexOf('Refuse deployment during protected reset')).toBeLessThan(
      workflow.indexOf('Deploy staging services')
    );
  });
});
