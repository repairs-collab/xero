import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const deploymentFile = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'deploy', 'ovh', name), 'utf8');

describe('OVH voice deployment', () => {
  it('resolves the Australian VoIPcloud TCP registration endpoint on port 7060', () => {
    const composePath = resolve(process.cwd(), 'deploy', 'ovh', 'docker-compose.yml');
    const result = spawnSync(
      'docker',
      ['compose', '--profile', 'voice-capability', '-f', composePath, 'config', '--format', 'json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACCOUNT_PULSE_WEB_IMAGE: 'accountpulse-web:test',
          ACCOUNT_PULSE_WORKER_IMAGE: 'accountpulse-worker:test',
          ACCOUNT_PULSE_ASTERISK_IMAGE: 'accountpulse-asterisk:test',
          ACCOUNT_PULSE_VOICE_GATEWAY_IMAGE: 'accountpulse-voice-gateway:test',
          AWS_REGION: 'ap-southeast-2',
          DATABASE_NAME: 'accountpulse',
          DATABASE_USER: 'accountpulse',
          DATABASE_PASSWORD: 'test-password',
          DATABASE_URL: 'postgresql://accountpulse:test-password@postgres:5432/accountpulse',
          SEND_MODE: 'customer_live',
          NODE_ENV: 'production',
          PUBLIC_BASE_URL: 'https://billchaser.motts.com.au',
          COGNITO_DOMAIN: 'https://auth.example.test',
          COGNITO_REDIRECT_URI: 'https://billchaser.motts.com.au/auth/callback',
          COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-2.amazonaws.com/example',
          COGNITO_CLIENT_ID: 'test-client',
          COGNITO_USER_POOL_ID: 'test-pool',
          SESSION_SECRET_BASE64: 'dGVzdC1zZXNzaW9uLXNlY3JldA==',
          XERO_WEBHOOK_KEY: 'test-xero-webhook-key',
          XERO_API_CREDENTIALS: '{}',
          SINCH_CALLBACK_PUBLIC_KEYS_JSON: '{}',
          SINCH_WEBHOOK_TOKEN: 'test-sinch-token',
          SINCH_API_CREDENTIALS: '{}',
          ASTERISK_ARI_USERNAME: 'accountpulse',
          ASTERISK_ARI_PASSWORD: 'test-ari-password',
          ASTERISK_EXTERNAL_ADDRESS: '203.0.113.10',
          VOIPCLOUD_API_USER_NUMBER: '1011',
          VOIPCLOUD_SIP_USER_NUMBER: '61350324518',
          VOIPCLOUD_SIP_PASSWORD: 'test-sip-password',
          VOICE_SIP_BIND_IP: '203.0.113.10',
          VOICE_RTP_BIND_IP: '203.0.113.10',
          VOICE_GATEWAY_SIGNING_SECRET: 'test-signing-secret',
          VOIPCLOUD_API_KEY: 'test-api-key',
          VOICE_OFFICE_QUEUE_EXTENSION: '1003'
        }
      }
    );

    expect(result.status, result.stderr).toBe(0);
    const resolved = JSON.parse(result.stdout) as {
      services: {
        worker: { environment: { VOICE_GATEWAY_ACCEPT_CALLS: string } };
        'voice-gateway': { environment: { VOICE_GATEWAY_ACCEPT_CALLS: string } };
        asterisk: {
          environment: {
            VOIPCLOUD_SIP_DOMAIN: string;
            VOIPCLOUD_SIP_SERVER: string;
          };
          ports: Array<{ protocol: string; published: string; target: number }>;
        };
      };
    };
    expect(resolved.services.worker.environment.VOICE_GATEWAY_ACCEPT_CALLS).toBe('false');
    expect(resolved.services['voice-gateway'].environment.VOICE_GATEWAY_ACCEPT_CALLS).toBe('false');
    expect(resolved.services.asterisk.environment.VOIPCLOUD_SIP_SERVER).toBe(
      'sipm2.au.voipcloud.online:7060'
    );
    expect(resolved.services.asterisk.environment.VOIPCLOUD_SIP_DOMAIN).toBe(
      'sipm2.au.voipcloud.online'
    );
    expect(resolved.services.asterisk.ports).toContainEqual(
      expect.objectContaining({ protocol: 'tcp', published: '5060', target: 5060 })
    );
  }, 15_000);

  it('registers and places VoIPcloud calls over TCP with the PBX user mapped separately from SIP auth', () => {
    const pjsip = deploymentFile('asterisk/pjsip.conf.template');
    const extensions = deploymentFile('asterisk/extensions.conf');
    const entrypoint = deploymentFile('asterisk/entrypoint.sh');
    const compose = deploymentFile('docker-compose.yml');

    expect(pjsip).toContain('[transport-tcp]');
    expect(pjsip).toContain('protocol = tcp');
    expect(pjsip.match(/transport = transport-tcp/g)).toHaveLength(2);
    expect(pjsip).not.toContain('transport = transport-udp');
    expect(pjsip).toContain(
      'set_var = ACCOUNT_PULSE_PROVIDER_USER_NUMBER=${VOIPCLOUD_API_USER_NUMBER}'
    );
    expect(extensions).toContain('${ACCOUNT_PULSE_PROVIDER_USER_NUMBER}');
    expect(extensions).not.toContain('provider-user,${EXTEN}');
    expect(entrypoint).toContain('VOIPCLOUD_API_USER_NUMBER is required');
    expect(entrypoint).toContain('$VOIPCLOUD_API_USER_NUMBER');
    expect(compose).toContain(
      'VOIPCLOUD_API_USER_NUMBER: ${VOIPCLOUD_API_USER_NUMBER:?VOIPCLOUD_API_USER_NUMBER is required}'
    );
  });

  it('injects the private Retell credential only into server containers', () => {
    const compose = deploymentFile('docker-compose.yml');

    expect(compose).toContain('ACCOUNT_PULSE_WEB_IMAGE');
    expect(compose).toContain('ACCOUNT_PULSE_WORKER_IMAGE');
    expect(compose.match(/^\s+RETELL_API_KEY:/gm)).toHaveLength(3);
    expect(compose).not.toMatch(/NEXT_PUBLIC_.*RETELL/i);
    expect(compose).not.toContain('.dkr.ecr.');
    expect(compose).toContain('SEND_MODE: ${SEND_MODE:?SEND_MODE is required}');
  });

  it('keeps the shared worker and gateway customer-call gate disabled by default', () => {
    const compose = deploymentFile('docker-compose.yml');

    expect(
      compose.match(
        /VOICE_GATEWAY_ACCEPT_CALLS: \$\{VOICE_GATEWAY_ACCEPT_CALLS:-false\}/g
      )
    ).toHaveLength(2);
    expect(compose).not.toContain('VOICE_GATEWAY_ACCEPT_CALLS: true');
  });

  it('never enables automatic customer voice through a migration or Compose default', () => {
    const compose = deploymentFile('docker-compose.yml');
    const migration = readFileSync(
      resolve(process.cwd(), 'packages', 'db', 'drizzle', '0011_independent_voice_sequences.sql'),
      'utf8'
    );

    expect(migration).toContain('"automatic_enabled" boolean DEFAULT false NOT NULL');
    expect(migration).not.toMatch(/automatic_enabled[^;]*(?:DEFAULT|=)\s*true/i);
    expect(compose).not.toMatch(/AUTOMATIC_(?:CUSTOMER_)?VOICE[^\n]*true/i);
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

  it('proves Piper can read the pinned model as the non-root runtime user', () => {
    const dockerfile = readFileSync(
      resolve(process.cwd(), 'apps', 'voice-gateway', 'Dockerfile'),
      'utf8'
    );
    const runtimeUser = dockerfile.indexOf('USER node');
    const smokeTest = dockerfile.indexOf("'AccountPulse voice gateway ready.'");

    expect(dockerfile).toContain('chmod 0444 /opt/accountpulse/voices/en_GB-alba-medium/*');
    expect(runtimeUser).toBeGreaterThan(-1);
    expect(smokeTest).toBeGreaterThan(runtimeUser);
  });

  it('uses a shared RAM-only audio volume with the common non-root UID', () => {
    const compose = deploymentFile('docker-compose.yml');

    expect(compose).toContain(
      'voice_audio:/var/lib/asterisk/sounds/accountpulse:ro'
    );
    expect(compose).toContain(
      'voice_audio:/dev/shm/accountpulse-voice'
    );
    expect(compose).toContain('type: tmpfs');
    expect(compose).toContain('device: tmpfs');
    expect(compose).toContain('o: uid=1000,gid=1000,mode=0700');
  });
});
