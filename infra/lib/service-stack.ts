import { ArnFormat, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerImage,
  ContainerInsights,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  Protocol,
  Secret as EcsSecret
} from 'aws-cdk-lib/aws-ecs';
import type { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  SslPolicy
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  Effect,
  PolicyStatement,
  ServicePrincipal
} from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

import type { DataStack } from './data-stack.js';
import type { IdentityStack } from './identity-stack.js';
import type { DeploymentStage, NetworkStack } from './network-stack.js';

export interface ServiceStackProps extends StackProps {
  stage: DeploymentStage;
  network: NetworkStack;
  data: DataStack;
  identity: IdentityStack;
  certificateArn: string;
  hostname: string;
  imageTag: string;
}

export class ServiceStack extends Stack {
  readonly cluster: Cluster;
  readonly webService: FargateService;
  readonly workerService: FargateService;
  readonly webRepository: Repository;
  readonly workerRepository: Repository;
  readonly loadBalancer: ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);
    const logKey = new Key(this, 'LogKey', {
      enableKeyRotation: true,
      alias: `alias/${props.stage}/bill-chaser-logs`
    });
    const logGroupArn = this.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: `/bill-chaser-5000/${props.stage}/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });
    logKey.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [
          new ServicePrincipal(`logs.${this.region}.amazonaws.com`)
        ],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*'
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': logGroupArn
          }
        }
      })
    );
    const webLogs = new LogGroup(this, 'WebLogs', {
      logGroupName: `/bill-chaser-5000/${props.stage}/web`,
      retention: RetentionDays.ONE_YEAR,
      encryptionKey: logKey
    });
    const workerLogs = new LogGroup(this, 'WorkerLogs', {
      logGroupName: `/bill-chaser-5000/${props.stage}/worker`,
      retention: RetentionDays.ONE_YEAR,
      encryptionKey: logKey
    });

    this.webRepository = props.data.webRepository;
    this.workerRepository = props.data.workerRepository;
    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.network.vpc,
      containerInsightsV2: ContainerInsights.ENABLED
    });

    const commonEnvironment = {
      NODE_ENV: 'production',
      AWS_REGION: 'ap-southeast-2',
      SEND_MODE: 'dry-run',
      DATABASE_HOST: props.data.database.dbInstanceEndpointAddress,
      DATABASE_PORT: props.data.database.dbInstanceEndpointPort,
      DATABASE_NAME: 'bc5000'
    };
    const databaseSecrets = {
      DATABASE_USER: EcsSecret.fromSecretsManager(
        props.data.database.secret!,
        'username'
      ),
      DATABASE_PASSWORD: EcsSecret.fromSecretsManager(
        props.data.database.secret!,
        'password'
      )
    };

    const webTask = new FargateTaskDefinition(this, 'WebTask', {
      cpu: 512,
      memoryLimitMiB: 1024
    });
    webTask.addToTaskRolePolicy(
      new PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDisableUser'
        ],
        resources: [props.identity.userPool.userPoolArn]
      })
    );
    const web = webTask.addContainer('Web', {
      image: ContainerImage.fromEcrRepository(
        this.webRepository,
        props.imageTag
      ),
      logging: LogDrivers.awsLogs({ logGroup: webLogs, streamPrefix: 'web' }),
      environment: {
        ...commonEnvironment,
        COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${props.identity.userPool.userPoolId}`,
        COGNITO_CLIENT_ID: props.identity.userPoolClient.userPoolClientId,
        COGNITO_USER_POOL_ID: props.identity.userPool.userPoolId,
        COGNITO_DOMAIN: `https://${props.identity.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
        COGNITO_REDIRECT_URI: `https://${props.hostname}/auth/callback`
      },
      secrets: {
        ...databaseSecrets,
        SESSION_SECRET_BASE64: EcsSecret.fromSecretsManager(
          props.data.sessionSecret
        ),
        XERO_WEBHOOK_KEY: EcsSecret.fromSecretsManager(
          props.data.xeroWebhookSecret
        ),
        SINCH_CALLBACK_PUBLIC_KEYS_JSON: EcsSecret.fromSecretsManager(
          props.data.sinchWebhookKey
        )
      },
      healthCheck: {
        command: [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(45)
      }
    });
    web.addPortMappings({ containerPort: 3000, protocol: Protocol.TCP });

    const workerTask = new FargateTaskDefinition(this, 'WorkerTask', {
      cpu: 512,
      memoryLimitMiB: 1024
    });
    workerTask.addContainer('Worker', {
      image: ContainerImage.fromEcrRepository(
        this.workerRepository,
        props.imageTag
      ),
      logging: LogDrivers.awsLogs({
        logGroup: workerLogs,
        streamPrefix: 'worker'
      }),
      environment: {
        ...commonEnvironment,
        PUBLIC_BASE_URL: `https://${props.hostname}`
      },
      secrets: {
        ...databaseSecrets,
        XERO_API_CREDENTIALS: EcsSecret.fromSecretsManager(
          props.data.xeroApiSecret
        ),
        SINCH_API_CREDENTIALS: EcsSecret.fromSecretsManager(
          props.data.sinchApiSecret
        )
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "process.kill(1,0)"'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(20)
      }
    });

    this.webService = new FargateService(this, 'WebService', {
      cluster: this.cluster,
      taskDefinition: webTask,
      desiredCount: props.stage === 'production' ? 2 : 1,
      assignPublicIp: false,
      securityGroups: [props.network.webSecurityGroup],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200
    });
    this.workerService = new FargateService(this, 'WorkerService', {
      cluster: this.cluster,
      taskDefinition: workerTask,
      desiredCount: props.stage === 'production' ? 2 : 1,
      assignPublicIp: false,
      securityGroups: [props.network.workerSecurityGroup],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
      minHealthyPercent: 50,
      maxHealthyPercent: 100
    });

    this.loadBalancer = new ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.network.vpc,
      internetFacing: true,
      securityGroup: props.network.loadBalancerSecurityGroup,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      dropInvalidHeaderFields: true
    });
    const certificate = Certificate.fromCertificateArn(
      this,
      'Certificate',
      props.certificateArn
    );
    const listener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [certificate],
      open: false,
      sslPolicy: SslPolicy.RECOMMENDED_TLS
    });
    listener.addTargets('WebTargets', {
      port: 3000,
      protocol: ApplicationProtocol.HTTP,
      targets: [this.webService],
      healthCheck: {
        path: '/health/ready',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30)
      },
      deregistrationDelay: Duration.seconds(30)
    });

    this.webService
      .autoScaleTaskCount({
        minCapacity: props.stage === 'production' ? 2 : 1,
        maxCapacity: 8
      })
      .scaleOnCpuUtilization('WebCpuScaling', {
        targetUtilizationPercent: 65
      });
    this.workerService
      .autoScaleTaskCount({
        minCapacity: props.stage === 'production' ? 2 : 1,
        maxCapacity: 12
      })
      .scaleOnCpuUtilization('WorkerCpuScaling', {
        targetUtilizationPercent: 70
      });
  }
}
