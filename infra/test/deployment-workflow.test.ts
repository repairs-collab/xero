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
});
