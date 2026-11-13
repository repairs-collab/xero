import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shell = process.platform === 'win32'
  ? resolve(dirname(dirname(execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!)), 'usr', 'bin', 'sh.exe')
  : '/bin/bash';
const helper = readFileSync(resolve(process.cwd(), 'deploy/ovh/rollback-safety.sh'), 'utf8');

describe('rollback safety guard', () => {
  it.each([
    ['stop failure', '1', '0', false],
    ['database failure', '0', '1', true],
    ['success', '0', '0', true]
  ])('fails closed on %s', (_label, stopFail, sqlFail, expectsSql) => {
    const script = `${helper}\nfake_compose() {\n  if [ "$1" = stop ]; then echo STOP; [ "$STOP_FAIL" != 1 ]; return; fi\n  echo SQL; while IFS= read -r line; do printf '%s\\n' "$line"; done; [ "$SQL_FAIL" != 1 ];\n}\nrollback_safeguard fake_compose\nprintf 'RESULT:%s\\n' "$?"\n`;
    const result = spawnSync(shell, ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, STOP_FAIL: stopFail, SQL_FAIL: sqlFail } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STOP');
    expect(result.stdout.includes('SQL')).toBe(expectsSql);
    expect(result.stdout).toContain(stopFail === '1' || sqlFail === '1' ? 'RESULT:1' : 'RESULT:0');
    if (expectsSql) expect(result.stdout).toContain("status = 'INCOMPLETE'");
  });

  it('blocks older images when forward-migrated direct-debit history is unresolved', () => {
    const script = `${helper}\nfake_compose() {\n  if [ "$1" = stop ]; then echo STOP; return 0; fi\n  legacy=0\n  reconciliation=0\n  while IFS= read -r line; do\n    printf '%s\\n' "$line"\n    case "$line" in *"status = 'LEGACY_UNBOUND'"*) legacy=1 ;; esac\n    case "$line" in *provider_reconciled_at*) reconciliation=1 ;; esac\n  done\n  if [ "$legacy" = 1 ] && [ "$reconciliation" = 1 ]; then return 1; fi\n  return 0\n}\nrollback_safeguard fake_compose\nprintf 'RESULT:%s\\n' "$?"\n`;
    const result = spawnSync(shell, ['-s'], {
      input: script,
      encoding: 'utf8',
      env: process.env
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STOP');
    expect(result.stdout).toContain("status = 'LEGACY_UNBOUND'");
    expect(result.stdout).toContain('provider_reconciled_at');
    expect(result.stdout).toContain('RESULT:1');
  });
});
