import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryFile = (path: string): string => {
  const absolutePath = resolve(process.cwd(), path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

describe('OVH release pipeline', () => {
  it('keeps Linux deployment scripts executable across Windows checkouts', () => {
    const attributes = repositoryFile('.gitattributes');

    expect(attributes).toContain('*.sh text eol=lf');
  });

  it('builds once and deploys immutable artifacts through protected OVH production', () => {
    const workflow = repositoryFile('.github/workflows/deploy.yml');

    expect(workflow).not.toMatch(/configure-aws-credentials|amazon-ecr-login/i);
    expect(workflow).not.toMatch(/\b(?:cdk|cloudformation|ecs|ecr|rds)\b/i);
    expect(workflow).toContain('IMAGE_TAG: ${{ github.sha }}');
    expect(workflow).toContain('accountpulse-web:${IMAGE_TAG}');
    expect(workflow).toContain('accountpulse-worker:${IMAGE_TAG}');
    expect(workflow.match(/environment: staging/g)).toBeNull();
    expect(workflow.match(/environment: production/g)).toHaveLength(1);
    expect(workflow.match(/accountpulse-images-\$\{\{ github\.sha \}\}/g)).toHaveLength(2);
    expect(workflow).toContain('Install pinned OVH host key');
    expect(workflow.indexOf('Install pinned OVH host key')).toBeLessThan(
      workflow.indexOf('Transfer immutable release bundle')
    );
    expect(workflow.match(/Run migration and health-checked release/g)).toHaveLength(1);
    expect(workflow.match(/Record rollback metadata/g)).toHaveLength(1);
  });

  it('uses only the scoped OVH release connection contract', () => {
    const workflow = repositoryFile('.github/workflows/deploy.yml');

    for (const name of [
      'OVH_HOST',
      'OVH_PORT',
      'OVH_USER',
      'OVH_SSH_PRIVATE_KEY',
      'OVH_SSH_HOST_KEY',
      'OVH_DEPLOY_PATH',
      'HOSTNAME'
    ]) {
      expect(workflow).toContain(name);
    }
    expect(workflow).not.toContain('AWS_DEPLOY_ROLE_ARN');
    expect(workflow).not.toContain('AWS_ACCOUNT_ID');
    expect(workflow).not.toContain('CERTIFICATE_ARN');
  });

  it('installs commercial credentials through protected production secrets', () => {
    const workflow = repositoryFile('.github/workflows/deploy.yml');
    const installer = repositoryFile(
      'deploy/ovh/install-protected-environment.sh'
    );

    for (const name of [
      'XERO_OAUTH_CLIENT_ID',
      'XERO_OAUTH_CLIENT_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SOLO_PRICE_ID',
      'STRIPE_PORTAL_CONFIGURATION_ID'
    ]) {
      expect(workflow).toContain(`secrets.${name}`);
      expect(installer).toContain(name);
    }
    for (const name of [
      'ACCOUNT_PULSE_LEGAL_ENTITY',
      'ACCOUNT_PULSE_SUPPORT_EMAIL',
      'SMS_NUMBER_QUARANTINE_DAYS'
    ]) {
      expect(workflow).toContain(`vars.${name}`);
      expect(installer).toContain(name);
    }
    expect(workflow).toContain('install-protected-environment.sh');
    expect(workflow).toContain('Install protected production environment');
    expect(installer).toContain('docker inspect');
    expect(installer).toContain('umask 077');
    expect(installer).toContain('install -m 0600');
    expect(installer).toContain('current-images.env');
    expect(installer).toContain('XERO_TOKEN_ENCRYPTION_KEYS_JSON');
    expect(installer).not.toContain('set -x');
  });

  it('locks, backs up, migrates, checks health and restores images on failure', () => {
    const release = repositoryFile('deploy/ovh/release.sh');

    expect(release).toContain('flock');
    expect(release).toContain('pg_dump');
    expect(release).toContain('^[0-9a-f]{40}$');
    expect(release).toContain('accountpulse-web:${RELEASE_SHA}');
    expect(release).toContain('accountpulse-worker:${RELEASE_SHA}');
    expect(release).toContain('worker.mjs migrate');
    expect(release).toContain('/health/ready');
    expect(release).toContain('rollback_images');
    expect(release).toContain('previous-images.env');
    expect(release).toContain('release-metadata.json');
  });

  it('rolls back only to a recorded immutable release without restoring the database', () => {
    const rollback = repositoryFile('deploy/ovh/rollback.sh');

    expect(rollback).toContain('^[0-9a-f]{40}$');
    expect(rollback).toContain('releases/${TARGET_SHA}/images.env');
    expect(rollback).toContain('/health/ready');
    expect(rollback).not.toContain('pg_restore');
    expect(rollback).not.toContain('psql <');
    expect(rollback).not.toMatch(/(?:latest|stable|production):/);
  });

  it('adds the commercial hostname without replacing the existing Motts site', () => {
    const installer = repositoryFile('deploy/ovh/install-public-hostname.sh');
    const site = repositoryFile('deploy/ovh/accountpulse-site.caddy');

    expect(site).toContain('ap.motts.com.au');
    expect(site).toContain('reverse_proxy web:3000');
    expect(installer).toContain('billchaser.motts.com.au');
    expect(installer).toContain('caddy validate');
    expect(installer).toContain('caddy reload');
    expect(installer).toContain('ERR trap');
    expect(installer).toContain('openssl s_client');
    expect(installer).toContain('curl --fail');
    expect(installer).toContain('--retry-all-errors');
    expect(installer).toContain('cat "$candidate" > "$CADDYFILE"');
    expect(installer).toContain('--force-recreate caddy');
    expect(installer).not.toContain(
      'install -m 0644 "$candidate" "$CADDYFILE"'
    );
    expect(installer).toContain('already serves valid HTTPS');
    expect(installer).not.toMatch(/^\s*rm\s+.*Caddyfile/m);
  });
});
