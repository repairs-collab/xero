import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

describe('AccountPulse OVH deployment workflow', () => {
  it('has no AWS application deployment path', () => {
    expect(workflow).not.toMatch(/aws-actions|amazon-ecr|cloudformation|\bcdk\b|\becs\b|\becr\b/i);
    expect(workflow).not.toContain('AWS_DEPLOY_ROLE_ARN');
    expect(workflow).not.toContain('AWS_ACCOUNT_ID');
  });

  it('builds once and deploys the exact artifact to protected production', () => {
    expect(workflow).toContain('Build immutable images once');
    expect(workflow.match(/accountpulse-images-\$\{\{ github\.sha \}\}/g)).toHaveLength(2);
    expect(workflow).toContain('deploy-production:');
    expect(workflow).toMatch(/deploy-production:[\s\S]*needs: verify-and-build/);
    expect(workflow).not.toContain('deploy-staging:');
  });

  it('pins the OVH host identity before transfer', () => {
    expect(workflow.match(/OVH_SSH_HOST_KEY/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workflow).toContain('~/.ssh/known_hosts');
    expect(workflow).not.toContain('ssh-keyscan');
    expect(workflow.indexOf('Install pinned OVH host key')).toBeLessThan(
      workflow.indexOf('Transfer immutable release bundle')
    );
  });

  it('passes commercial credentials only through the protected environment', () => {
    for (const name of [
      'XERO_OAUTH_CLIENT_ID',
      'XERO_OAUTH_CLIENT_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SOLO_MONTHLY_PRICE_ID',
      'STRIPE_SOLO_ANNUAL_PRICE_ID',
      'STRIPE_PORTAL_CONFIGURATION_ID'
    ]) {
      expect(workflow).toContain(`secrets.${name}`);
    }
    expect(workflow).toContain('Install protected production environment');
    expect(workflow.indexOf('Install protected production environment')).toBeLessThan(
      workflow.indexOf('Run migration and health-checked release')
    );
  });

  it('cannot invoke reset or customer activation from a normal deployment', () => {
    expect(workflow).not.toContain('operational-reset');
    expect(workflow).not.toContain('CUSTOMER_ROLLOUT');
    expect(workflow).not.toContain('rolloutScope');
    expect(workflow).not.toContain('SEND_MODE=');
  });

  it('serialises releases and never cancels an in-flight production change', () => {
    expect(workflow).toContain('group: accountpulse-ovh-release');
    expect(workflow).toContain('cancel-in-progress: false');
  });
});
