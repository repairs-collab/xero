import { Stack, type StackProps } from 'aws-cdk-lib';
import {
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc
} from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

export type DeploymentStage = 'development' | 'staging' | 'production';

export interface BillChaserStackProps extends StackProps {
  stage: DeploymentStage;
}

export class NetworkStack extends Stack {
  readonly vpc: Vpc;
  readonly loadBalancerSecurityGroup: SecurityGroup;
  readonly webSecurityGroup: SecurityGroup;
  readonly workerSecurityGroup: SecurityGroup;
  readonly databaseSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: BillChaserStackProps) {
    super(scope, id, props);
    if (Stack.of(this).region !== 'ap-southeast-2') {
      throw new Error('Bill Chaser 5000 may only deploy to ap-southeast-2');
    }

    this.vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: props.stage === 'production' ? 2 : 1,
      subnetConfiguration: [
        {
          name: 'public-alb',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24
        },
        {
          name: 'private-application',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24
        },
        {
          name: 'isolated-database',
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24
        }
      ]
    });

    this.loadBalancerSecurityGroup = new SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: false,
      description: 'Public HTTPS ingress for Bill Chaser'
    });
    this.loadBalancerSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(443),
      'Public HTTPS'
    );

    this.webSecurityGroup = new SecurityGroup(this, 'WebSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Private web tasks'
    });
    this.webSecurityGroup.addIngressRule(
      this.loadBalancerSecurityGroup,
      Port.tcp(3000),
      'ALB to web'
    );

    this.workerSecurityGroup = new SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Private background worker tasks'
    });
    this.databaseSecurityGroup = new SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: false,
      description: 'Isolated PostgreSQL access'
    });
    this.databaseSecurityGroup.addIngressRule(
      this.webSecurityGroup,
      Port.tcp(5432),
      'Web to PostgreSQL'
    );
    this.databaseSecurityGroup.addIngressRule(
      this.workerSecurityGroup,
      Port.tcp(5432),
      'Worker to PostgreSQL'
    );
  }
}
