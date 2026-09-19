import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/deploy.yml'),
  'utf8'
);

describe('deployment image scanning', () => {
  it('uses scan-on-push results without requesting a redundant rescan', () => {
    expect(workflow).not.toContain('start-image-scan');
    expect(workflow).toContain('aws ecr wait image-scan-complete');
  });

  it('parses and rejects numeric critical or high findings', () => {
    expect(workflow).toContain('read -r CRITICAL HIGH <<< "$FINDINGS"');
    expect(workflow).toContain('CRITICAL=${CRITICAL/None/0}');
    expect(workflow).toContain('HIGH=${HIGH/None/0}');
    expect(workflow).toContain('if (( CRITICAL > 0 || HIGH > 0 )); then');
    expect(workflow).not.toContain('"None\\tNone"');
  });
});
