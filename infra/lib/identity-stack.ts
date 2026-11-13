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
        emailSubject: 'Verify your AccountPulse account',
        emailBody:
          'Welcome to AccountPulse. Your verification code is {####}. If you did not request this account, contact ap@motts.com.au.',
        emailStyle: VerificationEmailStyle.CODE
      },
      userInvitation: {
        emailSubject: 'Welcome to AccountPulse — your account is ready',
        emailBody:
          `Welcome to AccountPulse. Your secure customer account has been created.\n\nUsername: {username}\nTemporary password: {####}\n\nSign in at https://${props.hostname}/auth/login?returnTo=%2Fonboarding\n\nOn first sign-in you will set a new password and MFA, accept the AccountPulse Terms and Privacy Policy, connect Xero, and complete guided setup.\n\nThis invitation expires in 3 days. If you were not expecting it, contact ap@motts.com.au.`
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
