import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const deploymentFile = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'deploy', 'ovh', name), 'utf8');

const composeEnvironment = {
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
  PUBLIC_BASE_URL: 'https://accountpulse.example.test',
  ACCOUNT_PULSE_LEGAL_ENTITY: 'Swan Hill Appliance Repairs Pty Ltd',
  ACCOUNT_PULSE_SUPPORT_EMAIL: 'repairs@motts.com.au',
  COGNITO_DOMAIN: 'https://auth.example.test',
  COGNITO_REDIRECT_URI: 'https://accountpulse.example.test/auth/callback',
  COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-2.amazonaws.com/example',
  COGNITO_CLIENT_ID: 'test-client',
  COGNITO_USER_POOL_ID: 'test-pool',
  SESSION_SECRET_BASE64: 'dGVzdC1zZXNzaW9uLXNlY3JldA==',
  XERO_WEBHOOK_KEY: 'test-xero-webhook-key',
  XERO_OAUTH_CLIENT_ID: 'test-xero-oauth-client',
  XERO_OAUTH_CLIENT_SECRET: 'test-xero-oauth-secret',
  XERO_OAUTH_REDIRECT_URI: 'https://accountpulse.example.test/xero/callback',
  XERO_TOKEN_ENCRYPTION_KEYS_JSON: '{"primary":"dGVzdC14ZXJvLWtleQ=="}',
  XERO_TOKEN_ACTIVE_KEY_ID: 'primary',
  XERO_API_CREDENTIALS: '{}',
  STRIPE_SECRET_KEY: 'sk_test_example',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_example',
  STRIPE_SOLO_PRICE_ID: 'price_test_solo',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_test_solo',
  SINCH_CALLBACK_PUBLIC_KEYS_JSON: '{}',
  SINCH_WEBHOOK_TOKEN: 'test-sinch-token',
  SINCH_API_CREDENTIALS: '{}',
  SMS_NUMBER_QUARANTINE_DAYS: '1',
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
};

const resolveCompose = () => {
  const composePath = resolve(process.cwd(), 'deploy', 'ovh', 'docker-compose.yml');
  return spawnSync(
    'docker',
    ['compose', '--profile', 'voice-capability', '-f', composePath, 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      env: composeEnvironment
    }
  );
};

describe('OVH voice deployment', () => {
  it('resolves the Australian VoIPcloud TCP registration endpoint on port 7060', () => {
    const result = resolveCompose();

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

  it('keeps application credentials hosting-neutral on OVH', () => {
    const result = resolveCompose();

    expect(result.status, result.stderr).toBe(0);
    const resolved = JSON.parse(result.stdout) as {
      services: Record<string, { environment?: Record<string, string>; image?: string }>;
    };
    const forbiddenEnvironmentKeys = [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'XERO_SECRET_ARN',
      'SINCH_SECRET_ARN'
    ];

    for (const serviceName of ['web', 'worker']) {
      const service = resolved.services[serviceName];
      expect(service).toBeDefined();
      for (const key of forbiddenEnvironmentKeys) {
        expect(service?.environment).not.toHaveProperty(key);
      }
      expect(service?.image).not.toMatch(/(?:\.dkr\.ecr\.|amazonaws\.com)/i);
    }

    expect(deploymentFile('docker-compose.yml')).not.toMatch(/XERO_SECRET_ARN|SINCH_SECRET_ARN/);
    expect(readFileSync(resolve(process.cwd(), '.env.example'), 'utf8')).not.toMatch(
      /XERO_SECRET_ARN|SINCH_SECRET_ARN|arn:aws:secretsmanager/i
    );
  }, 15_000);

  it('injects OAuth into both runtimes while isolating web and delivery-only secrets', () => {
    const result = resolveCompose();

    expect(result.status, result.stderr).toBe(0);
    const resolved = JSON.parse(result.stdout) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    const sharedXeroEnvironment = {
      XERO_OAUTH_CLIENT_ID: composeEnvironment.XERO_OAUTH_CLIENT_ID,
      XERO_OAUTH_CLIENT_SECRET: composeEnvironment.XERO_OAUTH_CLIENT_SECRET,
      XERO_OAUTH_REDIRECT_URI: composeEnvironment.XERO_OAUTH_REDIRECT_URI,
      XERO_TOKEN_ENCRYPTION_KEYS_JSON: composeEnvironment.XERO_TOKEN_ENCRYPTION_KEYS_JSON,
      XERO_TOKEN_ACTIVE_KEY_ID: composeEnvironment.XERO_TOKEN_ACTIVE_KEY_ID
    };

    expect(resolved.services.web?.environment).toEqual(
      expect.objectContaining({
        ...sharedXeroEnvironment,
        ACCOUNT_PULSE_LEGAL_ENTITY: composeEnvironment.ACCOUNT_PULSE_LEGAL_ENTITY,
        ACCOUNT_PULSE_SUPPORT_EMAIL: composeEnvironment.ACCOUNT_PULSE_SUPPORT_EMAIL,
        COGNITO_DOMAIN: composeEnvironment.COGNITO_DOMAIN,
        COGNITO_REDIRECT_URI: composeEnvironment.COGNITO_REDIRECT_URI,
        COGNITO_ISSUER: composeEnvironment.COGNITO_ISSUER,
        COGNITO_CLIENT_ID: composeEnvironment.COGNITO_CLIENT_ID,
        COGNITO_USER_POOL_ID: composeEnvironment.COGNITO_USER_POOL_ID,
        STRIPE_SECRET_KEY: composeEnvironment.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: composeEnvironment.STRIPE_WEBHOOK_SECRET,
        STRIPE_SOLO_PRICE_ID: composeEnvironment.STRIPE_SOLO_PRICE_ID,
        STRIPE_PORTAL_CONFIGURATION_ID: composeEnvironment.STRIPE_PORTAL_CONFIGURATION_ID
      })
    );
    expect(resolved.services.worker?.environment).toEqual(
      expect.objectContaining({
        ...sharedXeroEnvironment,
        SINCH_API_CREDENTIALS: composeEnvironment.SINCH_API_CREDENTIALS
      })
    );
    expect(resolved.services.worker?.environment).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(resolved.services.worker?.environment).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
    expect(resolved.services.worker?.environment).not.toHaveProperty('COGNITO_DOMAIN');
    expect(resolved.services.worker?.environment).not.toHaveProperty('COGNITO_CLIENT_ID');
    expect(resolved.services.worker?.environment).not.toHaveProperty('XERO_WEBHOOK_KEY');
    expect(resolved.services.worker?.environment).not.toHaveProperty(
      'SINCH_CALLBACK_PUBLIC_KEYS_JSON'
    );
    expect(resolved.services.worker?.environment).not.toHaveProperty('SINCH_WEBHOOK_TOKEN');
  }, 15_000);

  it('starts the customer OAuth worker without legacy Custom Connection credentials', () => {
    const environment: NodeJS.ProcessEnv = {
      ...composeEnvironment,
      XERO_API_CREDENTIALS: undefined
    };
    const composePath = resolve(
      process.cwd(),
      'deploy',
      'ovh',
      'docker-compose.yml'
    );
    const result = spawnSync(
      'docker',
      ['compose', '-f', composePath, 'config', '--format', 'json'],
      { encoding: 'utf8', env: environment }
    );

    expect(result.status, result.stderr).toBe(0);
    const resolved = JSON.parse(result.stdout) as {
      services: { worker: { environment: Record<string, string> } };
    };
    expect(resolved.services.worker.environment.XERO_API_CREDENTIALS ?? '').toBe(
      ''
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

  it('injects the private VoIPcloud gateway credential only into server containers', () => {
    const compose = deploymentFile('docker-compose.yml');

    expect(compose).toContain('ACCOUNT_PULSE_WEB_IMAGE');
    expect(compose).toContain('ACCOUNT_PULSE_WORKER_IMAGE');
    expect(compose.match(/^\s+VOICE_GATEWAY_SIGNING_SECRET:/gm)).toHaveLength(3);
    expect(compose.match(/^\s+VOICE_GATEWAY_URL:/gm)).toHaveLength(2);
    expect(compose).not.toContain('RETELL_API_KEY:');
    expect(compose).not.toMatch(/NEXT_PUBLIC_.*VOICE_GATEWAY/i);
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
