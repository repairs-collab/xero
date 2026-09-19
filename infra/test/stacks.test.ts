import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { DataStack } from '../lib/data-stack.js';
import { IdentityStack } from '../lib/identity-stack.js';
import { NetworkStack } from '../lib/network-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';
import { ServiceStack } from '../lib/service-stack.js';

function synthesise() {
  const app = new App();
  const env = { account: '123456789012', region: 'ap-southeast-2' };
  const network = new NetworkStack(app, 'Network', {
    env,
    stage: 'production'
  });
  const data = new DataStack(app, 'Data', {
    env,
    stage: 'production',
    network
  });
  const identity = new IdentityStack(app, 'Identity', {
    env,
    stage: 'production'
  });
  const services = new ServiceStack(app, 'Services', {
    env,
    stage: 'production',
    network,
    data,
    identity,
    certificateArn:
      'arn:aws:acm:ap-southeast-2:123456789012:certificate/00000000-0000-0000-0000-000000000000',
    hostname: 'billchaser.example.com',
    imageTag: '0123456789abcdef'
  });
  const observability = new ObservabilityStack(app, 'Observability', {
    env,
    stage: 'production',
    data,
    services
  });
  return { app, network, data, identity, services, observability };
}

const stacks = synthesise();
const dataTemplate = Template.fromStack(stacks.data);
const identityTemplate = Template.fromStack(stacks.identity);
const serviceTemplate = Template.fromStack(stacks.services);
const observabilityTemplate = Template.fromStack(stacks.observability);
const assembly = stacks.app.synth();

describe('Bill Chaser 5000 AWS stacks', () => {
  it('keeps RDS private, encrypted, Multi-AZ, and backed up for 35 days', () => {
    dataTemplate.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      MultiAZ: true,
      BackupRetentionPeriod: 35,
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^17\\.')
    });
  });

  it('requires MFA in the Cognito user pool', () => {
    identityTemplate.hasResourceProperties(
      'AWS::Cognito::UserPool',
      {
        MfaConfiguration: 'ON',
        EnabledMfas: Match.arrayWith(['SOFTWARE_TOKEN_MFA'])
      }
    );
  });

  it('deploys separate private web and worker services behind HTTPS', () => {
    serviceTemplate.resourceCountIs('AWS::ECS::Service', 2);
    serviceTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS'
    });
    serviceTemplate.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          AssignPublicIp: 'DISABLED'
        }
      }
    });
  });

  it('gives provider credential access to the worker role only', () => {
    const policies = serviceTemplate.findResources('AWS::IAM::Policy');
    const webPolicy = JSON.stringify(
      Object.entries(policies).find(([id]) => id.startsWith('WebTask'))?.[1]
    );
    const workerPolicy = JSON.stringify(
      Object.entries(policies).find(([id]) => id.startsWith('WorkerTask'))?.[1]
    );
    expect(workerPolicy).toContain('XeroApiSecret');
    expect(workerPolicy).toContain('SinchApiSecret');
    expect(webPolicy).not.toContain('XeroApiSecret');
    expect(webPolicy).not.toContain('SinchApiSecret');
  });

  it('generates parseable non-live provider placeholders', () => {
    dataTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'production/bill-chaser-5000/xero-api',
      GenerateSecretString: {
        GenerateStringKey: 'clientSecret',
        SecretStringTemplate: '{"clientId":"not-configured"}'
      }
    });
    dataTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'production/bill-chaser-5000/sinch-api',
      GenerateSecretString: {
        GenerateStringKey: 'apiSecret',
        SecretStringTemplate: '{"apiKey":"not-configured"}'
      }
    });
    dataTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'production/bill-chaser-5000/sinch-webhook-public-key',
      GenerateSecretString: {
        GenerateStringKey: 'not-configured',
        SecretStringTemplate: '{}'
      }
    });
  });

  it('allows regional CloudWatch Logs to use the log encryption key', () => {
    serviceTemplate.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: {
              Service: 'logs.ap-southeast-2.amazonaws.com'
            },
            Condition: {
              ArnLike: {
                'kms:EncryptionContext:aws:logs:arn': Match.anyValue()
              }
            }
          })
        ])
      }
    });
  });

  it('creates operational alarms without embedding secret values', () => {
    const templates = assembly.stacks.map(
      (artifact): unknown => artifact.template as unknown
    );
    const serialised = JSON.stringify(templates);
    expect(serialised).not.toContain('"apiSecret":"');
    expect(serialised).not.toContain('"clientSecret":"');
    observabilityTemplate.resourceCountIs(
      'AWS::CloudWatch::Alarm',
      9
    );
    expect(Stack.of(stacks.services).region).toBe('ap-southeast-2');
  });
});
