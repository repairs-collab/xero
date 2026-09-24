import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
  UserPoolEmail,
  VerificationEmailStyle
} from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

import type { DeploymentStage } from './network-stack.js';

export interface IdentityStackProps extends StackProps {
  stage: DeploymentStage;
  hostname: string;
}

export class IdentityStack extends Stack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  readonly userPoolDomain: UserPoolDomain;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `${props.stage}-bill-chaser-5000`,
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: Duration.days(3)
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      email: UserPoolEmail.withCognito(),
      userVerification: {
        emailSubject: 'Verify your Bill Chaser 5000 account',
        emailStyle: VerificationEmailStyle.CODE
      },
      removalPolicy: RemovalPolicy.RETAIN
    });
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${props.stage}-bill-chaser-web`,
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [`https://${props.hostname}/auth/callback`],
        logoutUrls: [`https://${props.hostname}/auth/logout`]
      }
    });
    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: {
        domainPrefix: `${props.stage}-bill-chaser-5000`
      }
    });
  }
}
