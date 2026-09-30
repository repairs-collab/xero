import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/approved-sms-recovery.yml'),
  'utf8'
);

describe('approved SMS recovery workflow', () => {
  it('pins recovery to the deployed production worker and exact reviewed count', () => {
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('group: bill-chaser-production');
    expect(workflow).toContain('ref: ${{ inputs.deployed_commit }}');
    expect(workflow).toContain(
      'Production worker image does not match the approved deployed commit'
    );
    expect(workflow).toContain('EXPECTED_COUNT');
    expect(workflow).toContain('EXPECTED_DIGEST');
    expect(workflow).toContain('--expected-digest');
    expect(workflow).toContain(
      'RECOVER APPROVED UNSENT SMS FOR $LOCAL_DATE'
    );
    expect(workflow).toContain('"recover-approved-sms","preview"');
    expect(workflow).toContain('"recover-approved-sms","execute"');
  });
});
