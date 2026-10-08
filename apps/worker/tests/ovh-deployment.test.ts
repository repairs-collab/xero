import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const deploymentFile = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'deploy', 'ovh', name), 'utf8');

describe('OVH voice deployment', () => {
  it('injects the private Retell credential only into server containers', () => {
    const compose = deploymentFile('docker-compose.yml');

    expect(compose).toContain('ACCOUNT_PULSE_WEB_IMAGE');
    expect(compose).toContain('ACCOUNT_PULSE_WORKER_IMAGE');
    expect(compose.match(/^\s+RETELL_API_KEY:/gm)).toHaveLength(3);
    expect(compose).not.toMatch(/NEXT_PUBLIC_.*RETELL/i);
    expect(compose).not.toContain('.dkr.ecr.');
    expect(compose).toContain('SEND_MODE: ${SEND_MODE:?SEND_MODE is required}');
  });

  it('runs the bounded voice monitor from an OVH systemd timer', () => {
    const service = deploymentFile('accountpulse-voice-monitor.service');
    const timer = deploymentFile('accountpulse-voice-monitor.timer');
    const logMonitor = deploymentFile('accountpulse-voice-log-monitor.sh');

    expect(service).toContain('bc5000-compose --profile monitor run --rm voice-monitor');
    expect(service).toContain('VOICE_QUEUE_AGE_ALARM_SECONDS');
    expect(service).toContain('RETELL_WEBHOOK_LAG_ALARM_SECONDS');
    expect(service).toContain('accountpulse-voice-log-monitor.sh');
    expect(timer).toContain('OnUnitActiveSec=5min');
    expect(logMonitor).toContain('retell_webhook_signature_failures_total');
    expect(logMonitor).toContain('RETELL_SIGNATURE_FAILURE_ALARM_COUNT');
  });
});
