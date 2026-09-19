import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps
} from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Repository, RepositoryEncryption } from 'aws-cdk-lib/aws-ecr';
import { Key } from 'aws-cdk-lib/aws-kms';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion
} from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

import type { DeploymentStage, NetworkStack } from './network-stack.js';

export interface DataStackProps extends StackProps {
  stage: DeploymentStage;
  network: NetworkStack;
}

const retainedSecret = (
  scope: Construct,
  id: string,
  stage: DeploymentStage,
  name: string
) => {
  const secret = new Secret(scope, id, {
    secretName: `${stage}/bill-chaser-5000/${name}`,
    generateSecretString: {
      passwordLength: 48,
      excludePunctuation: false,
      excludeCharacters: '"@/\\'
    }
  });
  secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
  return secret;
};

const retainedJsonSecret = (
  scope: Construct,
  id: string,
  stage: DeploymentStage,
  name: string,
  template: Record<string, string>,
  generatedKey: string
) => {
  const secret = new Secret(scope, id, {
    secretName: `${stage}/bill-chaser-5000/${name}`,
    generateSecretString: {
      secretStringTemplate: JSON.stringify(template),
      generateStringKey: generatedKey,
      passwordLength: 48,
      excludePunctuation: false,
      excludeCharacters: '"@/\\'
    }
  });
  secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
  return secret;
};

export class DataStack extends Stack {
  readonly database: DatabaseInstance;
  readonly dataKey: Key;
  readonly sessionSecret: Secret;
  readonly xeroApiSecret: Secret;
  readonly xeroWebhookSecret: Secret;
  readonly sinchApiSecret: Secret;
  readonly sinchWebhookKey: Secret;
  readonly webRepository: Repository;
  readonly workerRepository: Repository;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    this.dataKey = new Key(this, 'DataKey', {
      enableKeyRotation: true,
      alias: `alias/${props.stage}/bill-chaser-5000`,
      removalPolicy: RemovalPolicy.RETAIN
    });

    this.database = new DatabaseInstance(this, 'Database', {
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.network.databaseSecurityGroup],
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_17_7
      }),
      instanceType: InstanceType.of(
        InstanceClass.T4G,
        props.stage === 'production' ? InstanceSize.MEDIUM : InstanceSize.SMALL
      ),
      databaseName: 'bc5000',
      credentials: Credentials.fromGeneratedSecret('bc5000'),
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      multiAz: true,
      publiclyAccessible: false,
      backupRetention: Duration.days(35),
      deletionProtection: props.stage === 'production',
      removalPolicy:
        props.stage === 'production'
          ? RemovalPolicy.RETAIN
          : RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: 365,
      autoMinorVersionUpgrade: true,
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: this.dataKey,
      performanceInsightRetention: 731
    });

    this.sessionSecret = new Secret(this, 'SessionSecret', {
      secretName: `${props.stage}/bill-chaser-5000/session`,
      generateSecretString: {
        passwordLength: 43,
        excludePunctuation: true
      }
    });
    this.sessionSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.xeroApiSecret = retainedJsonSecret(
      this,
      'XeroApiSecret',
      props.stage,
      'xero-api',
      { clientId: 'not-configured' },
      'clientSecret'
    );
    this.xeroWebhookSecret = retainedSecret(this, 'XeroWebhookSecret', props.stage, 'xero-webhook');
    this.sinchApiSecret = retainedJsonSecret(
      this,
      'SinchApiSecret',
      props.stage,
      'sinch-api',
      { apiKey: 'not-configured' },
      'apiSecret'
    );
    this.sinchWebhookKey = retainedJsonSecret(
      this,
      'SinchWebhookKey',
      props.stage,
      'sinch-webhook-public-key',
      {},
      'not-configured'
    );
    this.webRepository = new Repository(this, 'WebRepository', {
      repositoryName: `${props.stage}-bill-chaser-web`,
      imageScanOnPush: true,
      encryption: RepositoryEncryption.KMS,
      encryptionKey: this.dataKey,
      lifecycleRules: [{ maxImageCount: 50, rulePriority: 1 }]
    });
    this.workerRepository = new Repository(this, 'WorkerRepository', {
      repositoryName: `${props.stage}-bill-chaser-worker`,
      imageScanOnPush: true,
      encryption: RepositoryEncryption.KMS,
      encryptionKey: this.dataKey,
      lifecycleRules: [{ maxImageCount: 50, rulePriority: 1 }]
    });
  }
}
